/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import {
	Logger, logger,
	LoggingDebugSession,
	InitializedEvent, TerminatedEvent, StoppedEvent, BreakpointEvent, InvalidatedEvent,
	Thread
} from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import { SolanaRuntime, ISolanaBreakpoint, FileAccessor } from './debugRuntime';
import { Subject } from 'await-notify';

/**
 * This interface describes the solana-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the solana-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
}

export class SolanaDebugSession extends LoggingDebugSession {
	private _isRunningLldb = false;

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	// a olana runtime (or debugger)
	private _runtime: SolanaRuntime;

	private _configurationDone = new Subject();

	private _showHex = false;
	private _useInvalidatedEvent = false;

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(fileAccessor: FileAccessor) {
		super("solana-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

		this._runtime = new SolanaRuntime();

		// setup event handlers
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', SolanaDebugSession.threadID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', SolanaDebugSession.threadID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', SolanaDebugSession.threadID));
		});
		this._runtime.on('breakpointValidated', (bp: ISolanaBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: bp.verified, id: bp.id } as DebugProtocol.Breakpoint));
		});
		// this._runtime.on('output', (text, filePath, line, column) => {
		// 	const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);

		// 	if (text === 'start' || text === 'startCollapsed' || text === 'end') {
		// 		e.body.group = text;
		// 		e.body.output = `group-${text}\n`;
		// 	}

		// 	e.body.source = this.createSource(filePath);
		// 	e.body.line = this.convertDebuggerLineToClient(line);
		// 	e.body.column = this.convertDebuggerColumnToClient(column);
		// 	this.sendEvent(e);
		// });
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected async initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {

		if (args.supportsInvalidatedEvent) {
			this._useInvalidatedEvent = false;
		}

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// the adapter implements the configurationDoneRequest.
		response.body.supportsConfigurationDoneRequest = true;

		// make VS Code to use 'evaluate' when hovering over source
		// response.body.supportsEvaluateForHovers = false;

		// make VS Code to support completion in REPL
		response.body.supportsCompletionsRequest = false;
		response.body.completionTriggerCharacters = [ ".", "[" ];

		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		// make VS Code provide "Step in Target" functionality
		response.body.supportsStepInTargetsRequest = true;

		// make VS Code able to read variable memory
		response.body.supportsReadMemoryRequest = true;

		response.body.supportsDisassembleRequest = true;
		response.body.supportsLoadedSourcesRequest = true;

		await this._runtime.initLLDB();

		console.log("AFTER initLLDB");

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);
		console.log("BEFORE START");
		// start the program in the runtime
		await this._runtime.start(args.program, !!args.stopOnEntry, !!args.noDebug);
		console.log("AFTER START");

		this.sendResponse(response);
	}

	protected async loadedSourcesRequest(response: DebugProtocol.LoadedSourcesResponse, args: DebugProtocol.LoadedSourcesArguments, request?: DebugProtocol.Request | undefined) {
		console.log("ADAPTER loadedSourcesRequest");
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request: DebugProtocol.SetBreakpointsRequest) {
		console.log("setBreakPointsRequest to str: ", JSON.stringify(request));

		// Convert to path in dwarfdump
		let lldbPath = args.source.path?.split("code/")[1];

		// Solana sdk
		if (lldbPath?.includes('sdk')) {
			lldbPath = 'home/home/' + lldbPath.split('sdk/program/')[1];
		}
		// Rust core
		else if (lldbPath?.includes('rust-solana')) {
			lldbPath = '/home/runner/work/bpf-tools/bpf-tools/out/rust/' + lldbPath.split('rust-solana-1.59.0/')[1];
		}
		// Project files
		else {
			lldbPath = 'home/' + lldbPath;
		}
		console.log("lldb path (after split): ", lldbPath);
		request.arguments.source.path = lldbPath;

		await this.lldbRun('request_setBreakpoints', JSON.stringify(request));
		console.log("END ADAPTER setBreakPointsRequest");

		// const path = args.source.path as string;
		// let clientLines:number[] = [];

		// // clear all breakpoints for this file
		// this._runtime.clearBreakpoints(path);

		// // set and verify breakpoint locations
		// const actualBreakpoints0 = clientLines.map(async l => {
		// 	const { verified, line, id } = await this._runtime.setBreakPoint(path, l);
		// 	const bp = new Breakpoint(verified, line) as DebugProtocol.Breakpoint;
		// 	bp.id = id;
		// 	return bp;
		// });
		// const actualBreakpoints = await Promise.all<DebugProtocol.Breakpoint>(actualBreakpoints0);

		// // send back the actual breakpoint positions
		// response.body = {
		// 	breakpoints: actualBreakpoints
		// };

		// this.sendResponse(response);
	}

	protected async breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request) {
        console.log("ADAPTER breakpointLocationsRequest");

		if (args.source.path) {
			const bps = this._runtime.getBreakpoints(args.source.path, args.line);
			response.body = {
				breakpoints: bps.map(col => {
					return {
						line: args.line,
						column: this.convertDebuggerColumnToClient(col)
					};
				})
			};
		} else {
			response.body = {
				breakpoints: []
			};
		}
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
        console.log("ADAPTER threadsRequest");
		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(SolanaDebugSession.threadID, "thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected async sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request | undefined) {
        console.log("ADAPTER sourceRequest");
        console.log("sourceRequest: ", JSON.stringify(request));
		await this.lldbRun('request_source', JSON.stringify(request));
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments, request: DebugProtocol.StackTraceRequest) {
		console.log("ADAPTER stackTraceRequest");

		await this.lldbRun('request_stackTrace', JSON.stringify(request));
	}

	protected async scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request: DebugProtocol.ScopesRequest) {
		console.log("scopesRequest to str: ", JSON.stringify(request));

		await this.lldbRun('request_scopes', JSON.stringify(request));
	}

	protected async readMemoryRequest(response: DebugProtocol.ReadMemoryResponse, { offset = 0, count }: DebugProtocol.ReadMemoryArguments) {
		console.log("ADAPTER readMemoryRequest");

		response.body = {
			address: '0',
			data: this._runtime.memory.slice(offset, count).toString('base64'),
			unreadableBytes: this._runtime.memory.length - (offset + count)
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.VariablesRequest) {
		// FIXME: This is a quick hack, if we allow both 'named' and 'indexed' filter requests, the info in the UI will be doubled.
		if (args.filter === "named") {
			response.success = false;
			this.sendResponse(response);
			return;
		}
		console.log("variablesRequest to str: ", JSON.stringify(request));

		await this.lldbRun('request_variables', JSON.stringify(request));
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments) {
		console.log("ADAPTER continue");
		await this._runtime.continue();
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments) {
		console.log("ADAPTER nextRequest");
		await this._runtime.next();
		console.log("ADAPTER AFTER nextRequest");
		this.sendResponse(response);
	}

	protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
		console.log("ADAPTER stepInTargetsRequest");

		const targets = this._runtime.getStepInTargets(args.frameId);
		response.body = {
			targets: targets.map(t => {
				return { id: t.id, label: t.label };
			})
		};
		this.sendResponse(response);
	}

	protected async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments) {
		console.log("ADAPTER stepInRequest");

		await this._runtime.stepIn();
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		console.log("ADAPTER stepOutRequest");

		this._runtime.stepOut();
		this.sendResponse(response);
	}

	private _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

	private async lldbRun(funcName: string, request: string) {
		while (this._isRunningLldb) {
		    console.log("IS BUSY !!!!!!!!!!!!!!!!!!!!!!");
			console.log("REQUEST: ", request);
            await this._sleep(10);
		}
		this._isRunningLldb = true;
        console.log("lldbRun: ", request);
        let rxPtr = await this._runtime.lldb._malloc(request.length+1);
        console.log("request.length+1: ", request.length+1);
        let numBytesWritten = await this._runtime.lldb.stringToUTF8(request, rxPtr, request.length+1);
        console.log("numBytesWritten: ", numBytesWritten);
        const txPtr = await this._runtime.lldb.ccall(funcName, 'number', ['number'], [rxPtr], {async: true});
console.log("AFTER lldb call vscode");
        const responseStr = await this._runtime.lldb.UTF8ToString(txPtr);
        let responseJSON = JSON.parse(responseStr);

		// Convert stacktrace source path to workspace path
        if (funcName === 'request_stackTrace') {
		    const solSdkPath = '/home/wj/temp/test_theia/debug-test/code/sdk/program/';
			const rustCorePath = '/home/wj/temp/test_theia/debug-test/code/rust-solana-1.59.0/';
			const projectPath = '/home/wj/temp/test_theia/debug-test/code/';

			let responseAdj: DebugProtocol.StackTraceResponse = responseJSON;
			let totalFrames = responseAdj.body.totalFrames;
			totalFrames = (totalFrames !== undefined) ? totalFrames : 0;
			for (var id=0; id<totalFrames; id++) {
				if (responseAdj.body.stackFrames[id].source?.sourceReference !== undefined) {
					responseAdj.body.stackFrames[id].source!.name = responseAdj.body.stackFrames[id].name;
					continue;
				}
			    let sourcePath = responseAdj.body.stackFrames[id].source?.path;

				// Solana sdk
				if (sourcePath?.includes('home/home/')) {
					sourcePath = solSdkPath + sourcePath.split('home/home/')[1];
				}
				// Rust core
				else if (sourcePath?.includes('/home/runner')) {
					sourcePath = rustCorePath + sourcePath.split('out/rust/')[1];
				}
				// Project files
				else {
					sourcePath = projectPath + sourcePath?.split('home/')[1];
				}	
				console.log("lldb path (after split): ", sourcePath);
				responseAdj.body.stackFrames[id].source!.path = sourcePath;
			}
			responseJSON = responseAdj;
		}

        console.log("Response vscode22: ", responseJSON);

        // Send event to vscode
        this.sendResponse(responseJSON);

        // Clean up
        await this._runtime.lldb._free(rxPtr);
        await this._runtime.lldb._free(txPtr);

		console.log("END lldbRun");
		this._isRunningLldb = false;
	}

	protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {
		console.log("ADAPTER completionsRequest");

		response.body = {
			targets: [
				{
					label: "item 10",
					sortText: "10"
				},
				{
					label: "item 1",
					sortText: "01"
				},
				{
					label: "item 2",
					sortText: "02"
				},
				{
					label: "array[]",
					selectionStart: 6,
					sortText: "03"
				},
				{
					label: "func(arg)",
					selectionStart: 5,
					selectionLength: 3,
					sortText: "04"
				}
			]
		};
		this.sendResponse(response);
	}

	protected async disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments) {
		console.log("ADAPTER disassembleRequest");
	}

	protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
		console.log("ADAPTER customRequest");
		if (command === 'toggleFormatting') {
			this._showHex = ! this._showHex;
			if (this._useInvalidatedEvent) {
				this.sendEvent(new InvalidatedEvent( ['variables'] ));
			}
			this.sendResponse(response);
		} else {
			super.customRequest(command, response, args);
		}
	}
}
