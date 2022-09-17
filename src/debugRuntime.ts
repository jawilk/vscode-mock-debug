/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import lldbModule from "vscode-lldb-wasm";

export interface FileAccessor {
	readFile(path: string): Promise<string>;
}

export interface ISolanaBreakpoint {
	id: number;
	line: number;
	verified: boolean;
}

interface IStepInTargets {
	id: number;
	label: string;
}

interface IStackFrame {
	index: number;
	name: string;
	file: string;
	line: number;
	column?: number;
}

interface IStack {
	count: number;
	frames: IStackFrame[];
}

/**
 * Handling the debugging runtime.
 */
export class SolanaRuntime extends EventEmitter {
	public lldb;

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string = '';
	public get sourceFile() {
		return this._sourceFile;
	}

	// the contents (= lines) of the one and only file
	private _sourceLines: string[] = [];
	private _sourceTextAsMemory = Buffer.alloc(0);
	public get memory() {
		return this._sourceTextAsMemory;
	}

	// This is the next line that will be 'executed'
	private _currentLine = 0;
	private _currentColumn: number | undefined;

	// maps from sourceFile to array of Solana breakpoints
	private _breakPoints = new Map<string, ISolanaBreakpoint[]>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	constructor() {
		super();
	}

	/**
	 * Current byte offset in the file where the instruction pointer is located.
	 */
	public get currentByteOffset() {
		let offset = this._currentColumn || 0;
		for (let i = 0; i < this._currentLine; i++) {
			offset += this._sourceLines[i].length;
		}

		return offset;
	}

	public async initLLDB() {

		// TODO: remove hardcoded path
		const executableUriString = '/home/wj/temp/test_theia/debug-test/code/target/hello.so';
		this.lldb = await lldbModule({
			locateFile(path) {
			  console.log("PATH: ", path);
			  if (path.endsWith(`.wasm`)) {
				return 'packages/vscode-lldb-wasm/lldb.wasm';
				//return lldbWasmModule;
			  }
			  return path;
			},
		  });
		
        console.log("initLLDB after await MODULE");

		const data = await vscode.workspace.fs.readFile(vscode.Uri.parse(executableUriString));

         console.log("DATA: ", data);

		// TODO: check if lldb.wasm can load the executable directly from the workspace file system
		await this.lldb.FS.writeFile('executable.so', new Uint8Array(data));

		console.log("initLLDB after write FILE");
		  
		// Create target
		await this.lldb.ccall('create_target', null, ['string'], ['executable.so'], {async: true});
		await this.lldb.ccall('execute_command', null, ['string'], ['target list'], {async: true});


        console.log("initLLDB after create TARGET");

        // Connect to remote debugger
		await this.lldb.ccall('execute_command', null, ['string'], ['gdb-remote 9007'], {async: true});
		console.log("END initLLDB");
	}

	/**
	 * Start executing the given program.
	 */
	public async start(program: string, stopOnEntry: boolean, noDebug: boolean): Promise<void> {
		console.log("RUNTIME START");
		this.sendEvent('stopOnEntry');
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public async continue() {
		console.log("RUNTIME CONTINUE");

		await this.lldb.ccall('execute_command', null, ['string'], ['continue'], {async: true});
		this.sendEvent('stopOnBreakpoint');
	}

	/**
	 * Step to the next line (step over).
	 */
	 public async next() {
		console.log("RUNTIME: next");
		await this.lldb.ccall('request_next', null, [], [], {async: true});
		this.sendEvent('stopOnStep');
		console.log("END next");
	}

	/**
	 * Step into.
	 */
	public async stepIn() {
		console.log("RUNTIME: stepIn");
		await this.lldb.ccall('request_stepIn', null, [], [], {async: true});
		this.sendEvent('stopOnStep');
		console.log("END stepIn");
	}

	/**
	 * Step out.
	 */
	public async stepOut() {
		console.log("RUNTIME: stepOut");
		await this.lldb.ccall('request_stepOut', null, [], [], {async: true});
		this.sendEvent('stopOnStep');
		console.log("END stepOut");
	}

	public getStepInTargets(frameId: number): IStepInTargets[] {

		const line = this._sourceLines[this._currentLine].trim();

		// every word of the current line becomes a stack frame.
		const words = line.split(/\s+/);

		// return nothing if frameId is out of range
		if (frameId < 0 || frameId >= words.length) {
			return [];
		}

		// pick the frame for the given frameId
		const frame = words[frameId];

		const pos = line.indexOf(frame);

		// make every character of the frame a potential "step in" target
		return frame.split('').map((c, ix) => {
			return {
				id: pos + ix,
				label: `target: ${c}`
			};
		});
	}

	/**
	 * Returns a fake 'stacktrace' where every 'stackframe' is a word from the current line.
	 */
	public async stack(startFrame: number, endFrame: number): Promise<IStack> {
        console.log("RUNTIME STACK");
		const stackTrace = await this.lldb.ccall('get_stack_trace', 'string', [], [], {async: true});
		console.log("stackTrace: ", stackTrace);
		const stackTraceSplit = stackTrace.split(";");
		
		const line = +stackTraceSplit[0];
		const name = stackTraceSplit[1];
		let file = stackTraceSplit[2];
		
		console.log("line: ", line);
		console.log("name: ", name);
		console.log("file: ", file);
		
		// const words = this._sourceLines[this._currentLine].trim().split(/\s+/);

		const frames = new Array<IStackFrame>();
		// every word of the current line becomes a stack frame.
		// for (let i = startFrame; i < Math.min(endFrame, words.length); i++) {
			// const name = words[i];	// use a word of the line as the stackframe name
			const stackFrame: IStackFrame = {
				index: 0,
				name: name,
				file: file,	
				line: line
			};
			// if (typeof this._currentColumn === 'number') {
				// stackFrame.column = this._currentColumn;
			// }
			frames.push(stackFrame);
		// }
		return {
			frames: frames,
			count: 1//words.length
		};
	}

	public getBreakpoints(path: string, line: number): number[] {
        console.log("RUNTIME getBreakpoints");
		const l = this._sourceLines[line];

		let sawSpace = true;
		const bps: number[] = [];
		for (let i = 0; i < l.length; i++) {
			if (l[i] !== ' ') {
				if (sawSpace) {
					bps.push(i);
					sawSpace = false;
				}
			} else {
				sawSpace = true;
			}
		}

		return bps;
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public async setBreakPoint(path: string, line: number): Promise<ISolanaBreakpoint> {
		console.log("RUNTIME setBreakPoint");
	    console.log("path: ", path);
		console.log("line: ", line);

		// Convert to path in dwarfdump (Because the elf file was build with `-Z remap-cwd-prefix=home/`)
        let lldbPath = path.split("code/")[1];
		// Solana sdk
		if (lldbPath.includes('sdk')) {
		    lldbPath = 'home/home/' + lldbPath.split('sdk/program/');
		}
		// Rust core
		else if (lldbPath.includes('rust-solana')) {
			lldbPath = '/home/runner/work/bpf-tools/bpf-tools/out/rust/' + lldbPath.split('rust-solana-1.59.0/');
		}
		// Project files
		else {
			lldbPath = 'home/' + lldbPath.split('code/');
		}
		console.log("lldb path (after split): ", lldbPath);

		await this.lldb.ccall('set_breakpoint', null, ['string', 'number'], [lldbPath, line], {async: true});

		const bp: ISolanaBreakpoint = { verified: false, line, id: this._breakpointId++ };
		let bps = this._breakPoints.get(path);
		if (!bps) {
			bps = new Array<ISolanaBreakpoint>();
			this._breakPoints.set(path, bps);
		}
		bps.push(bp);

		await this.verifyBreakpoints(path);
		console.log("END RUNTIME setBreakPoint");

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number): ISolanaBreakpoint | undefined {
		console.log("RUNTIME clearBreakPoint");
		const bps = this._breakPoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				const bp = bps[index];
				bps.splice(index, 1);
				return bp;
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		this._breakPoints.delete(path);
	}

	// private methods

	private async verifyBreakpoints(path: string) {
        // TODO
		console.log("RUNTIME verifyBreakpoints");
		const bps = this._breakPoints.get(path);
		if (bps) {
			bps.forEach(bp => {
				bp.verified = true;
    			this.sendEvent('breakpointValidated', bp);
			});
		}
		console.log("END RUNTIME verifyBreakpoints");
	}

	private sendEvent(event: string, ... args: any[]): void {
		setTimeout(() => {
			this.emit(event, ...args);
		}, 0);
	}
}
