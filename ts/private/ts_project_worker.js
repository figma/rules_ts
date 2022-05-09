const fs = require('fs')
const ts = require('typescript')
const path = require('path')
const timers = require('timers/promises')
const worker = require('@bazel/worker')
const MNEMONIC = 'TsProject'

function noop() {}

function parseArgsFile() {
    let argsFilePath = process.argv.pop()
    if (argsFilePath.startsWith('@')) {
        argsFilePath = argsFilePath.slice(1)
    }
    return fs.readFileSync(argsFilePath).toString().split('\n')
}

/** @type {ts.FormatDiagnosticsHost} */
const formatDiagnosticHost = {
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine,
}

function printDiagnostics(diagnostics) {
    worker.log('')
    worker.log(ts.formatDiagnostics(diagnostics, formatDiagnosticHost))
}

/** @type {Date} */
let lastRequestTimestamp
/** @type {string} */
let lastRequestArgHash
/** @type {ts.WatchOfConfigFile<ts.EmitAndSemanticDiagnosticsBuilderProgram>} */
let program
/** @type {import("@bazel/worker").Inputs} */
let previousInputs

/** @type {Map<string, ts.FileWatcherCallback>} */
let invalidate = new Map()


function getProgram(args) {
    if (lastRequestArgHash !== args.join(' ')) {
        program = lastRequestArgHash = undefined
    }
    if (!program) {
        const parsedArgs = ts.parseCommandLine(args)
        const tsconfigPath = args[args.indexOf('--project') + 1]

        const execRoot = path.resolve(process.cwd(), '..', '..', '..')

        /** @type {ts.System} */
        const sys = {
            ...ts.sys,
            write: worker.log,
            writeOutputIsTTY: false,
            setTimeout: (callback) => {
               return setImmediate(callback)
            },
            clearTimeout: clearImmediate,
            watchFile: (filePath, callback) => {
                const relativeFilePath = path.relative(execRoot, filePath)
                invalidate.set(relativeFilePath, (kind) => callback(filePath, kind))
                return {close: () => invalidate.delete(relativeFilePath)}
            },
            watchDirectory: (path, callback, recursive, options) => {
                // TODO: Figure out what to do with directory watchers
                // tsc seem to be using them for watching the typeroots, node_modules tree, current dir
            }
        }
  
        const host = ts.createWatchCompilerHost(
            tsconfigPath,
            parsedArgs.options,
            sys,
            ts.createSemanticDiagnosticsBuilderProgram,
            noop,
            noop
        )

        lastRequestArgHash = args.join(' ')
        program = ts.createWatchProgram(host)
    }

    return program
}

async function emit(args, inputs, once = false) {
    lastRequestTimestamp = Date.now()

    if (previousInputs) {
        for (const input of Object.keys(previousInputs)) {
            if (!inputs[input]) {
                invalidate.get(input)?.(ts.FileWatcherEventKind.Deleted)
            }
        }
        for (const [input, digest] of Object.entries(inputs)) {
            if (!(input in previousInputs)) {
                invalidate.get(input)?.(ts.FileWatcherEventKind.Created)
            } else if (previousInputs[input] != digest) {
                invalidate.get(input)?.(ts.FileWatcherEventKind.Changed)
            }
        }
    }

    // Wait until the queue gets emptied. we are scheduling the program update via setImmediate above
    // hence we have to make sure we wait until the task queue gets flushed.
    await timers.setImmediate();

    // NOTE: Always get the program after the invalidation logic above as watcher program could
    // swap the program with new one based on the changes
    const program = getProgram(args).getProgram()

    const cancellationToken = {
        isCancellationRequested: function (timestamp) {
            return timestamp !== lastRequestTimestamp
        }.bind(null, lastRequestTimestamp),
        throwIfCancellationRequested: function (timestamp) {
            if (timestamp !== lastRequestTimestamp) {
                throw new ts.OperationCanceledException()
            }
        }.bind(null, lastRequestTimestamp),
    }

    const result = program.emit(undefined, undefined, cancellationToken)
    const diagnostics = ts.getPreEmitDiagnostics(
        program,
        undefined,
        cancellationToken
    )

    const succeded =
        !result.emitSkipped &&
        result?.diagnostics.length === 0 &&
        diagnostics.length == 0

    if (!succeded) {
        printDiagnostics(diagnostics)
    }

    previousInputs = inputs

    return succeded
}

function main() {
    if (worker.runAsWorker(process.argv)) {
        worker.log(`Running ${MNEMONIC} as a Bazel worker`)
        worker.runWorkerLoop(emit)
    } else {
        worker.log(`Running ${MNEMONIC} as a standalone process`)
        worker.log(`Started a new process to perform this action. Your build might be misconfigured, try \n build --strategy=${MNEMONIC}=worker`)
        const args = parseArgsFile()
        emit(args, {}, true)
    }
}

if (require.main === module) {
    main()
}
