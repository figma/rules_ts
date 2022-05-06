const fs = require("fs");
const ts = require("typescript");
const worker = require("@bazel/worker");
const MNEMONIC = 'TsProject';


const formatHost = {
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
};
const reportDiagnostic = (diagnostic) => {
    worker.log(ts.formatDiagnostic(diagnostic, formatHost));
};
const reportWatchStatusChanged = (diagnostic) => {
    worker.debug(ts.formatDiagnostic(diagnostic, formatHost));
};
function createWatchProgram(options, tsconfigPath, setTimeout) {
    const host = ts.createWatchCompilerHost(tsconfigPath, options, Object.assign(Object.assign({}, ts.sys), { setTimeout }), ts.createSemanticDiagnosticsBuilderProgram, reportDiagnostic, reportWatchStatusChanged);
    return ts.createWatchProgram(host);
}
let workerRequestTimestamp;
let cachedWatchedProgram;
let consolidateChangesCallback;
let cachedWatchProgramArgs;
function getWatchProgram(args) {
    const newWatchArgs = args.join(' ');
    if (cachedWatchedProgram && cachedWatchProgramArgs && cachedWatchProgramArgs !== newWatchArgs) {
        cachedWatchedProgram.close();
        cachedWatchedProgram = undefined;
        cachedWatchProgramArgs = undefined;
    }
    if (!cachedWatchedProgram) {
        const parsedArgs = ts.parseCommandLine(args);
        const tsconfigPath = args[args.indexOf('--project') + 1];
        cachedWatchProgramArgs = newWatchArgs;
        cachedWatchedProgram = createWatchProgram(parsedArgs.options, tsconfigPath, (callback) => {
            consolidateChangesCallback = callback;
        });
    }
    return cachedWatchedProgram;
}
function emitOnce(args) {

    const watchProgram = getWatchProgram(args);
    if (consolidateChangesCallback) {
        consolidateChangesCallback();
    }
    workerRequestTimestamp = Date.now();
    const program = watchProgram === null || watchProgram === void 0 ? void 0 : watchProgram.getProgram();
    const cancellationToken = {
        isCancellationRequested: function (timestamp) {
            return timestamp !== workerRequestTimestamp;
        }.bind(null, workerRequestTimestamp),
        throwIfCancellationRequested: function (timestamp) {
            if (timestamp !== workerRequestTimestamp) {
                throw new ts.OperationCanceledException();
            }
        }.bind(null, workerRequestTimestamp),
    };
    const result = program.emit(undefined, undefined, cancellationToken);
    const diagnostics = ts.getPreEmitDiagnostics(program, undefined, cancellationToken);
    let succeded = result && result.diagnostics.length === 0 && diagnostics.length == 0;
    return succeded;
}
function main() {
    if (worker.runAsWorker(process.argv)) {
        worker.log(`Running ${MNEMONIC} as a Bazel worker`);
        worker.runWorkerLoop(emitOnce);
    }
    else {
        worker.log(`Running ${MNEMONIC} as a standalone process`);
        worker.log(`Started a new process to perform this action. Your build might be misconfigured, try	
      --strategy=${MNEMONIC}=worker`);
        let argsFilePath = process.argv.pop();
        if (argsFilePath.startsWith('@')) {
            argsFilePath = argsFilePath.slice(1);
        }
        const args = fs.readFileSync(argsFilePath).toString().split('\n');
        emitOnce(args).finally(() => cachedWatchedProgram?.close());
    }
}
if (require.main === module) {
    main();
}