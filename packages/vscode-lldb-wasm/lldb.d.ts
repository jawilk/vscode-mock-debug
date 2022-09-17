/* eslint-disable */
export interface IlldbModule extends EmscriptenModule {
    //_execute_command(input: [string]): string;
    ccall(
        funcName: string,
        returnType: string | null,
        argTypes?: string[],
        args?: any[],
        opts?: Object,
      ): any;
    stringToUTF8(str: string, ptr: number): void;
    UTF8ToString(ptr: number): string;
    _free(ptr: number): void;
    FS;
    _execute_command(string): Promise<String>;
    _create_target(string): Promise<String>;
    _step(): Promise<String>;
    _get_registers(): Promise<String>;
}

interface FS {
    writeFile(string, Uint8Array);
}
  
export default function lldbModule(mod?: any): Promise<IlldbModule>;