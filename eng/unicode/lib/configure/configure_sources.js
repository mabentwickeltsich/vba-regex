// Based on Duktape 2.x tools/configure.py.

'use strict';

const { readFileUtf8, writeFileUtf8, readFileJson, writeFileJsonPretty, writeFileYamlPretty, mkdir } = require('../util/fs');
const { pathJoin, getCwd } = require('../util/fs');
const { getDukVersion } = require('../configure/duk_version');
const { generateDukConfigHeader } = require('../config/gen_duk_config');
const { generateBuiltins } = require('../builtins/gen_builtins');
const { cStrEncode } = require('../util/cquote');
const { GenerateC } = require('../util/generate_c');
const { combineSources } = require('../amalgamate/combine_src');
const { parseUnicodeText } = require('../unicode/parser');
const { createConversionMaps, removeConversionMapAscii, generateCaseconvTables } = require('../unicode/case_conversion');
const { extractCategories } = require('../unicode/categories');
const { filterCpMap, generateMatchTable3 } = require('../unicode/chars');
const { codepointSequenceToRanges, rangesToPrettyRangesDump, rangesToTextBitmapDump, dumpUnicodeCategories } = require('../unicode/util');
const { generateReCanonDirectLookup, generateReCanonBitmap } = require('../unicode/regexp_canon');
const { jsonDeepClone } = require('../util/clone');
const { numericSort } = require('../util/sort');
const { sourceFiles, selectCombinedSources } = require('../configure/source_files');
const { scanUsedStridxBidx } = require('../configure/scan_used_stridx_bidx');
const { getGitInfo } = require('../configure/git_info');
const { copyFiles, copyAndCQuote, copyFileUtf8AtSignReplace } = require('../configure/util');
const { assert } = require('../util/assert');

// Create a prologue for combined duktape.c.
function createSourcePrologue(args) {
    // Because duktape.c/duktape.h/duk_config.h are often distributed or
    // included in project sources as is, add a license reminder and
    // Duktape version information to the duktape.c header (duktape.h
    // already contains them).

    var genc = new GenerateC();
    genc.emitLine('/*');
    genc.emitLine(' *  Single source autogenerated distributable for Duktape ' + args.dukVersionFormatted);
    genc.emitLine(' *');
    genc.emitLine(' *  Git commit ' + args.gitCommit + ' (' + args.gitDescribe + ').');
    genc.emitLine(' *  Git branch ' + args.gitBranch + '.');
    genc.emitLine(' *');
    genc.emitLine(' *  See Duktape AUTHORS.rst and LICENSE.txt for copyright and');
    genc.emitLine(' *  licensing information.');
    genc.emitLine(' */');
    genc.emitLine('');

    // Add LICENSE.txt and AUTHORS.rst to combined source so that they're automatically
    // included and are up-to-date.

    genc.emitLine('/* LICENSE.txt */');
    readFileUtf8(args.licenseFile).split('\n').forEach((line) => {
        genc.emitLine(line);
    });
    genc.emitLine('');
    genc.emitLine('/* AUTHORS.rst */');
    readFileUtf8(args.authorsFile).split('\n').forEach((line) => {
        genc.emitLine(line);
    });
    return genc.getString();
}

// Create duktape.h, using @KEYWORD@ replacements.
function createDuktapeH(inputDirectory, outputDirectory, tempDirectory, replacements) {
    copyFileUtf8AtSignReplace(pathJoin(inputDirectory, 'duktape.h.in'),
        pathJoin(outputDirectory, 'duktape.h'),
        replacements);
}

// Extract a matcher for a codepoint set.
function extractChars(cpMap, includeList, excludeList) {
    var filteredCpMap = filterCpMap(cpMap, includeList, excludeList);
    var codepoints = numericSort(filteredCpMap.map((ent) => Number(ent.cp)));
    var ranges = codepointSequenceToRanges(codepoints);
    var { data, nbits, freq } = generateMatchTable3(ranges);
    void nbits;
    void freq;
    return { data, ranges };
}

// Parse Unicode data and generate useful intermediate outputs.
function generateUnicodeFiles(unicodeDataFile, specialCasingFile, tempDirectory, srcGenDirectory) {
    // Parse UnicodeData.txt and SpecialCasing.txt into a master codepoint map.
    var cpMap = parseUnicodeText(readFileUtf8(unicodeDataFile), readFileUtf8(specialCasingFile));
    writeFileJsonPretty(pathJoin(tempDirectory, 'codepoint_map.json'), cpMap);

    // Unicode categories.
    var cats = extractCategories(cpMap);
    writeFileJsonPretty(pathJoin(tempDirectory, 'unicode_categories.json'), cats);
    writeFileUtf8(pathJoin(tempDirectory, 'unicode_category_dump.txt'), dumpUnicodeCategories(cpMap, cats));

    // Case conversion maps.
    var convMaps = createConversionMaps(cpMap);
    writeFileJsonPretty(pathJoin(tempDirectory, 'conversion_maps.json'), convMaps);
    var convUcMap = jsonDeepClone(convMaps.uc);
    removeConversionMapAscii(convUcMap);
    var convLcMap = jsonDeepClone(convMaps.lc);
    removeConversionMapAscii(convLcMap);
    var { data: convUcNoa } = generateCaseconvTables(convUcMap);
    var { data: convLcNoa } = generateCaseconvTables(convLcMap);

    // RegExp canonicalization tables.
    var reCanonTab = generateReCanonDirectLookup(convMaps.uc);
    writeFileJsonPretty(pathJoin(tempDirectory, 're_canon_tab.json'), reCanonTab);
    var reCanonBitmap = generateReCanonBitmap(reCanonTab);
    writeFileJsonPretty(pathJoin(tempDirectory, 're_canon_bitmap.json'), reCanonBitmap);

    return;

    //var dontcare = require('./lib/unicode/regexp_canon').generateReCanonDontCare(canontab);
    //console.log(dontcare);
    //var ranges = require('./lib/unicode/regexp_canon').generateReCanonRanges(canontab);
    //console.log(ranges);
    //var needcheck = require('./lib/unicode/regexp_canon').generateReCanonNeedCheck(canontab);
    //console.log(needcheck);

    // Category helpers for matchers.
    var catsWs = ['Zs'];
    var catsLetter = ['Lu', 'Ll', 'Lt', 'Lm', 'Lo'];
    var catsIdStart = ['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Nl', 0x0024, 0x005f];
    var catsIdPart = ['Lu', 'Ll', 'Lt', 'Lm', 'Lo', 'Nl', 0x0024, 0x005f, 'Mn', 'Mc', 'Nd', 'Pc', 0x200c, 0x200d];

    // Matchers for various codepoint sets.
    var matchWs = extractChars(cpMap, catsWs, []);
    //var matchLetter = extractChars(cpMap, catsLetter, []);
    //var matchLetterNoa = extractChars(cpMap, catsLetter, [ 'ASCII' ]);
    //var matchLetterNoabmp = extractChars(cpMap, catsLetter, [ 'ASCII', 'NONBMP' ]);
    //var matchIdStart = extractChars(cpMap, catsIdStart, []);
    var matchIdStartNoa = extractChars(cpMap, catsIdStart, ['ASCII']);
    var matchIdStartNoabmp = extractChars(cpMap, catsIdStart, ['ASCII', 'NONBMP']);
    //var matchIdStartMinusLetter = extractChars(cpMap, catsIdStart, catsLetter);
    var matchIdStartMinusLetterNoa = extractChars(cpMap, catsIdStart, catsLetter.concat(['ASCII']));
    var matchIdStartMinusLetterNoabmp = extractChars(cpMap, catsIdStart, catsLetter.concat(['ASCII', 'NONBMP']));
    //var matchIdPartMinusIdStart = extractChars(cpMap, catsIdPart, catsIdStart);
    var matchIdPartMinusIdStartNoa = extractChars(cpMap, catsIdPart, catsIdStart.concat(['ASCII']));
    var matchIdPartMinusIdStartNoabmp = extractChars(cpMap, catsIdPart, catsIdStart.concat(['ASCII', 'NONBMP']));

    // Generate C/H files.

    function emitReCanonLookup() {
        var genc;

        genc = new GenerateC();
        genc.emitArray(reCanonTab, {
            tableName: 'duk_unicode_re_canon_lookup',
            typeName: 'duk_uint16_t',
            useConst: true,
            useCast: false,
            visibility: 'DUK_INTERNAL'
        });
        writeFileUtf8(pathJoin(srcGenDirectory, 'duk_unicode_re_canon_lookup.c'), genc.getString());

        genc = new GenerateC();
        genc.emitLine('#if !defined(DUK_SINGLE_FILE)');
        genc.emitLine('DUK_INTERNAL_DECL const duk_uint16_t duk_unicode_re_canon_lookup[' + reCanonTab.length + '];');
        genc.emitLine('#endif');
        writeFileUtf8(pathJoin(srcGenDirectory, 'duk_unicode_re_canon_lookup.h'), genc.getString());
    }

    function emitReCanonBitmap() {
        var genc;

        genc = new GenerateC();
        genc.emitArray(reCanonBitmap.bitmapContinuity, {
            tableName: 'duk_unicode_re_canon_bitmap',
            typeName: 'duk_uint8_t',
            useConst: true,
            useCast: false,
            visibility: 'DUK_INTERNAL'
        });
        writeFileUtf8(pathJoin(srcGenDirectory, 'duk_unicode_re_canon_bitmap.c'), genc.getString());

        genc = new GenerateC();
        genc.emitDefine('DUK_CANON_BITMAP_BLKSIZE', reCanonBitmap.blockSize);
        genc.emitDefine('DUK_CANON_BITMAP_BLKSHIFT', reCanonBitmap.blockShift);
        genc.emitDefine('DUK_CANON_BITMAP_BLKMASK', reCanonBitmap.blockMask);
        genc.emitLine('#if !defined(DUK_SINGLE_FILE)');
        genc.emitLine('DUK_INTERNAL_DECL const duk_uint8_t duk_unicode_re_canon_bitmap[' + reCanonBitmap.bitmapContinuity.length + '];');
        genc.emitLine('#endif');
        writeFileUtf8(pathJoin(srcGenDirectory, 'duk_unicode_re_canon_bitmap.h'), genc.getString());
    }

    function emitMatchTable(arg, tableName) {
        var genc;
        var data = arg.data;
        var ranges = arg.ranges;
        var filename = tableName;

        console.debug(tableName, data.length);

        genc = new GenerateC();
        genc.emitArray(data, {
            tableName: tableName,
            typeName: 'duk_uint8_t',
            useConst: true,
            useCast: false,
            visibility: 'DUK_INTERNAL'
        });
        writeFileUtf8(pathJoin(srcGenDirectory, filename + '.c'), genc.getString());

        genc = new GenerateC();
        genc.emitLine('#if !defined(DUK_SINGLE_FILE)');
        genc.emitLine('DUK_INTERNAL_DECL const duk_uint8_t ' + tableName + '[' + data.length + '];');
        genc.emitLine('#endif');
        writeFileUtf8(pathJoin(srcGenDirectory, filename + '.h'), genc.getString());

        writeFileUtf8(pathJoin(tempDirectory, filename + '_ranges.txt'), rangesToPrettyRangesDump(ranges));
        writeFileUtf8(pathJoin(tempDirectory, filename + '_bitmap.txt'), rangesToTextBitmapDump(ranges));
    }

    function emitCaseconvTables(ucData, lcData) {
        var genc;

        genc = new GenerateC();
        genc.emitArray(ucData, {
            tableName: 'duk_unicode_caseconv_uc',
            typeName: 'duk_uint8_t',
            useConst: true,
            useCast: false,
            visibility: 'DUK_INTERNAL'
        });
        genc.emitArray(lcData, {
            tableName: 'duk_unicode_caseconv_lc',
            typeName: 'duk_uint8_t',
            useConst: true,
            useCast: false,
            visibility: 'DUK_INTERNAL'
        });
        writeFileUtf8(pathJoin(srcGenDirectory, 'duk_unicode_caseconv.c'), genc.getString());

        genc = new GenerateC();
        genc.emitLine('#if !defined(DUK_SINGLE_FILE)');
        genc.emitLine('DUK_INTERNAL_DECL const duk_uint8_t duk_unicode_caseconv_uc[' + ucData.length + '];');
        genc.emitLine('DUK_INTERNAL_DECL const duk_uint8_t duk_unicode_caseconv_lc[' + lcData.length + '];');
        genc.emitLine('#endif');
        writeFileUtf8(pathJoin(srcGenDirectory, 'duk_unicode_caseconv.h'), genc.getString());
    }

    emitCaseconvTables(convUcNoa, convLcNoa);
    emitMatchTable(matchWs, 'duk_unicode_ws'); // not used runtime, but dump is useful
    emitMatchTable(matchIdStartNoa, 'duk_unicode_ids_noa');
    emitMatchTable(matchIdStartNoabmp, 'duk_unicode_ids_noabmp');
    emitMatchTable(matchIdStartMinusLetterNoa, 'duk_unicode_ids_m_let_noa');
    emitMatchTable(matchIdStartMinusLetterNoabmp, 'duk_unicode_ids_m_let_noabmp');
    emitMatchTable(matchIdPartMinusIdStartNoa, 'duk_unicode_idp_m_ids_noa');
    emitMatchTable(matchIdPartMinusIdStartNoabmp, 'duk_unicode_idp_m_ids_noabmp');
    emitReCanonLookup();
    emitReCanonBitmap();
}

function configureSources(args) {
    var sourceDirectory = assert(args.sourceDirectory, 'sourceDirectory must be given');
    var outputDirectory = assert(args.outputDirectory, 'outputDirectory must be given');
    var configDirectory = assert(args.configDirectory, 'configDirectory must be given');
    var tempDirectory = assert(args.tempDirectory);
    var licenseFile = assert(args.licenseFile);
    var authorsFile = assert(args.authorsFile);
    var unicodeDataFile = assert(args.unicodeDataFile);
    var specialCasingFile = assert(args.specialCasingFile);
    var gitCommit = args.gitCommit;
    var gitDescribe = args.gitDescribe;
    var gitBranch = args.gitBranch;
    var dukDistMetaFile = args.dukDistMetaFile;
    var distMeta;
    var autoGitCommit, autoGitDescribe, autoGitBranch;
    var gitCommitCString, gitDescribeCString, gitBranchCString;
    var dukVersion, dukMajor, dukMinor, dukPatch, dukVersionFormatted;
    var platform = args.platform;
    var compiler = args.compiler;
    var architecture = args.architecture;
    var forcedOptions = assert(args.forcedOptions);
    var fixupLines = assert(args.fixupLines);
    var romAutoLightFunc = args.romAutoLightFunc;
    var lineDirectives = args.lineDirectives;
    var c99TypesOnly = args.c99TypesOnly;
    var dll = args.dll;
    var emitConfigSanityCheck = args.emitConfigSanityCheck;
    var sanityStrict = args.sanityStrict;
    var useCppWarning = args.useCppWarning;
    var omitRemovedConfigOptions = args.omitRemovedConfigOptions;
    var omitDeprecatedConfigOptions = args.omitDeprecatedConfigOptions;
    var omitUnusedConfigOptions = args.omitUnusedConfigOptions;
    var userBuiltinFiles = args.userBuiltinFiles;
    var srcTempDirectory = pathJoin(tempDirectory, 'src-tmp');
    var srcGenDirectory = pathJoin(tempDirectory, 'src-gen');
    var entryCwd = getCwd();

    // Preparations: entry CWD, git info, Duktape version, etc.
    console.debug('entryCwd: ' + entryCwd);

    ({ dukVersion, dukMajor, dukMinor, dukPatch, dukVersionFormatted } =
        getDukVersion(pathJoin(sourceDirectory, 'duktape.h.in')));
    console.debug({ dukVersion, dukMajor, dukMinor, dukPatch, dukVersionFormatted });

    distMeta = {};
    if (dukDistMetaFile) {
        distMeta = readFileJson(dukDistMetaFile);
    }

    ({ gitCommit: autoGitCommit, gitDescribe: autoGitDescribe, gitBranch: autoGitBranch } = getGitInfo());
    gitCommit = gitCommit || distMeta.git_commit || autoGitCommit;
    gitDescribe = gitDescribe || distMeta.git_describe || autoGitDescribe;
    gitBranch = gitBranch || distMeta.git_branch || autoGitBranch;
    gitCommitCString = cStrEncode(gitCommit);
    gitBranchCString = cStrEncode(gitBranch);
    gitDescribeCString = cStrEncode(gitDescribe);
    console.debug({
        gitCommit,
        gitDescribe,
        gitBranch,
        gitCommitCString,
        gitDescribeCString,
        gitBranchCString
    });

    // Create output directory.
    mkdir(outputDirectory);

    // Copy sources files.
    mkdir(srcTempDirectory);
    mkdir(srcGenDirectory);
    copyFiles(sourceFiles, sourceDirectory, srcTempDirectory);

    // Prepare LICENSE.txt and AUTHORS.rst.
    copyAndCQuote(licenseFile, pathJoin(tempDirectory, 'LICENSE.txt.tmp'));
    copyAndCQuote(authorsFile, pathJoin(tempDirectory, 'AUTHORS.rst.tmp'));

    // Replacements for @FOO@ style placeholders.
    const atSignReplacementsShared = {
        LICENSE_TXT: readFileUtf8(pathJoin(tempDirectory, 'LICENSE.txt.tmp')),
        AUTHORS_RST: readFileUtf8(pathJoin(tempDirectory, 'AUTHORS.rst.tmp')),
        DUK_VERSION_FORMATTED: dukVersionFormatted,
        GIT_COMMIT: gitCommit,
        GIT_COMMIT_CSTRING: gitCommitCString,
        GIT_DESCRIBE: gitDescribe,
        GIT_DESCRIBE_CSTRING: gitDescribeCString,
        GIT_BRANCH: gitBranch,
        GIT_BRANCH_CSTRING: gitBranchCString
    };

    // Scan used stridx, bidx, config options, etc.
    var usedStridxEtcMeta = scanUsedStridxBidx(sourceFiles.map((fn) => pathJoin(sourceDirectory, fn)));

    // Create a duk_config.h.
    let cfgres = generateDukConfigHeader({
        configDirectory,
        tempDirectory,
        gitCommit,
        gitDescribe,
        gitBranch,
        platform,
        architecture,
        compiler,
        emitConfigSanityCheck,
        sanityStrict,
        useCppWarning,
        omitRemovedConfigOptions,
        omitDeprecatedConfigOptions,
        omitUnusedConfigOptions,
        forcedOpts: forcedOptions,
        dll,
        c99TypesOnly,
        fixupLines
    });
    writeFileUtf8(pathJoin(outputDirectory, 'duk_config.h'), cfgres.configHeaderString);
    writeFileJsonPretty(pathJoin(tempDirectory, 'active_opts.json'), cfgres.activeOpts);

    // Create a duktape.h.
    const atSignReplacements = jsonDeepClone(atSignReplacementsShared);
    atSignReplacements.DUK_SINGLE_FILE = '#define DUK_SINGLE_FILE';
    createDuktapeH(sourceDirectory, outputDirectory, tempDirectory, atSignReplacements);

    // Generate strings and built-in files from YAML metadata.
    var {
        preparedRomMetadata,
        unaugmentedRomMetadata,
        prettyRomMetadata,
        preparedRamMetadata,
        unaugmentedRamMetadata,
        prettyRamMetadata,
        sourceString: biSrc,
        headerString: biHdr,
        builtinsMetadata
    } = generateBuiltins({
        objectsMetadataFile: pathJoin(sourceDirectory, 'builtins.yaml'),
        stringsMetadataFile: pathJoin(sourceDirectory, 'strings.yaml'),
        usedStridxEtcMeta,
        dukVersion,
        userBuiltinFiles,
        activeOpts: cfgres.activeOpts,
        romAutoLightFunc,
    });
    void preparedRomMetadata;
    void preparedRamMetadata;
    writeFileYamlPretty(pathJoin(tempDirectory, 'rom_meta_unaugmented.yaml'), unaugmentedRomMetadata);
    writeFileUtf8(pathJoin(tempDirectory, 'rom_meta_pretty.txt'), prettyRomMetadata + '\n');
    writeFileYamlPretty(pathJoin(tempDirectory, 'ram_meta_unaugmented.yaml'), unaugmentedRamMetadata);
    writeFileUtf8(pathJoin(tempDirectory, 'ram_meta_pretty.txt'), prettyRamMetadata + '\n');
    writeFileUtf8(pathJoin(srcTempDirectory, 'duk_builtins.c'), biSrc);
    writeFileUtf8(pathJoin(srcTempDirectory, 'duk_builtins.h'), biHdr);

    // Generate Unicode tables as source/header files to be included later.
    generateUnicodeFiles(unicodeDataFile, specialCasingFile, tempDirectory, srcGenDirectory);

    // Generate source prologue.
    var prologueData = createSourcePrologue({
        dukVersionFormatted,
        gitCommit,
        gitDescribe,
        gitBranch,
        licenseFile: pathJoin(tempDirectory, 'LICENSE.txt.tmp'),
        authorsFile: pathJoin(tempDirectory, 'AUTHORS.rst.tmp')
    });
    writeFileUtf8(pathJoin(tempDirectory, 'prologue.tmp'), prologueData);

    // Combine sources,including autogenerated Unicode tables.
    var tmpSourceFiles = sourceFiles.concat(['duk_builtins.c']);
    var sourceList = selectCombinedSources(tmpSourceFiles, srcTempDirectory);
    var combinedSource, combinedMetadata;
    ({ combinedSource: combinedSource, metadata: combinedMetadata } = combineSources({
        sourceFiles: sourceList,
        includeExcluded: ['duk_config.h', 'duktape.h'],
        includePaths: [srcTempDirectory, srcGenDirectory],
        prologueFileName: pathJoin(tempDirectory, 'prologue.tmp'),
        lineDirectives
    }));
    writeFileUtf8(pathJoin(outputDirectory, 'duktape.c'), combinedSource);

    // Merge metadata files into a single output metadata file.
    var doc = {
        'type': 'duk_source_meta',
        'comment': 'Metadata for prepared Duktape sources and configuration',
        'git_commit': gitCommit,
        'git_branch': gitBranch,
        'git_describe': gitDescribe,
        'duk_version': dukVersion,
        'duk_version_string': dukVersionFormatted
    }
    Object.assign(doc, builtinsMetadata);
    Object.assign(doc, combinedMetadata);
    writeFileJsonPretty(pathJoin(outputDirectory, 'duk_source_meta.json'), doc);
}
exports.configureSources = configureSources;
exports.generateUnicodeFiles = generateUnicodeFiles;