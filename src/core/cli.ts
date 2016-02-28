import * as FS from 'fs';
import * as Path from 'path';

import Promise, { Resolvable } from 'thenfail';
import ExtendableError from 'extendable-error';

import {
    Command,
    Context,
    ParamDefinition,
    ParamsDefinition,
    OptionDefinition,
    HelpInfo
} from './command';

import {
    isStringCastable,
    Printable
} from './object';

export interface DescriptiveObject {
    brief?: string;
    description?: string;
}

const validCommandNameRegex = /^[\w\d]+(?:-[\w\d]+)*$/;

/**
 * Clime command line interface.
 */
export class CLI {
    root: string;
    description: string;

    constructor(
        public name: string,
        root: string
    ) {
        this.root = Path.resolve(root);
    }

    execute(argv: string[], cwd = process.cwd()): Promise<Printable | void> {
        return Promise.then(() => {
            let {
                commands,
                args,
                path
            } = this.preProcessArguments(argv);

            if (path) {
                // command file or directory exists
                let isFile = FS.statSync(path).isFile();

                if (isFile) {
                    return this.loadCommand(path, commands, args, cwd);
                } else {
                    throw HelpInfo.build(path);
                }
            } else {
                throw this.getHelp();
            }
        });
    }

    private preProcessArguments(argv: string[]): {
        commands: string[],
        args: string[],
        path: string
    } {
        let commands = [this.name];
        let searchPath = this.root;
        let argsIndex = 2;

        let entryPath = Path.join(this.root, 'default.js');
        let targetPath: string;

        if (FS.existsSync(entryPath)) {
            targetPath = entryPath;

            let module = require(entryPath);
            let object = (module.default || module) as DescriptiveObject;
            this.description = object.description;
        } else {
            targetPath = searchPath;
        }

        outer:
        for (let i = 2; i < argv.length; i++) {
            let arg = argv[i];

            if (validCommandNameRegex.test(arg)) {
                searchPath = Path.join(searchPath, arg);

                let possiblePaths = [
                    searchPath + '.js',
                    Path.join(searchPath, 'default.js'),
                    searchPath
                ];

                for (let possiblePath of possiblePaths) {
                    if (FS.existsSync(possiblePath)) {
                        targetPath = possiblePath;
                        argsIndex = i + 1;
                        commands.push(arg);
                        continue outer;
                    }
                }

                // If a directory at path `searchPath` does not exist, stop searching.
                if (!FS.existsSync(searchPath)) {
                    break;
                }
            } else {
                break;
            }
        }

        return {
            commands,
            args: argv.slice(argsIndex),
            path: targetPath
        };
    }

    private loadCommand(path: string, sequence: string[], args: string[], cwd: string): any {
        let module = require(path);
        let TargetCommand: Constructor<Command> & typeof Command = module.default || module;

        if (TargetCommand.prototype instanceof Command) {
            TargetCommand.path = path;
            TargetCommand.sequence = sequence;

            let {
                paramDefinitions,
                paramsDefinition,
                optionDefinitions,
                requiredParamsNumber
            } = TargetCommand;

            let argsParser = new ArgsParser(
                TargetCommand,
                paramDefinitions,
                paramsDefinition,
                optionDefinitions,
                requiredParamsNumber
            );

            let {
                args: commandArgs,
                extraArgs: commandExtraArgs,
                options: commandOptions,
                context,
                help
            } = argsParser.parse(sequence, args, cwd);

            let command = new TargetCommand();

            if (help) {
                return TargetCommand.getHelp();
            }

            let executeMethodArgs = commandArgs.concat();

            if (paramsDefinition) {
                executeMethodArgs.push(commandExtraArgs);
            }

            if (optionDefinitions) {
                executeMethodArgs.push(commandOptions);
            }

            executeMethodArgs.push(context)

            return command.execute(...executeMethodArgs);
        } else if (Path.basename(path) === 'default.js') {
            let dir = Path.dirname(path);
            throw HelpInfo.build(dir, TargetCommand.description);
        }
    }

    getHelp(): HelpInfo {
        return HelpInfo.build(this.root);
    }
}

export interface ParsedArgs {
    args?: any[];
    extraArgs?: any[];
    options?: HashTable<any>;
    context?: Context;
    help?: boolean;
}

export class ArgsParser {
    private optionDefinitionMap: HashTable<OptionDefinition<any>>;
    private optionFlagMapping: HashTable<string>;

    constructor(
        private helpProvider: HelpProvider,
        private paramDefinitions: ParamDefinition<any>[],
        private paramsDefinition: ParamsDefinition<any>,
        private optionDefinitions: OptionDefinition<any>[],
        private requiredParamsNumber: number
    ) {
        if (this.optionDefinitions) {
            this.optionFlagMapping = {};
            this.optionDefinitionMap = {};

            for (let definition of this.optionDefinitions) {
                let {
                    name,
                    flag,
                    required,
                    toggle,
                    default: defaultValue
                } = definition;

                this.optionDefinitionMap[name] = definition;

                if (flag) {
                    this.optionFlagMapping[flag] = name;
                }
            }
        }
    }

    parse(sequence: string[], args: string[], cwd: string): ParsedArgs {
        let that = this;

        args = args.concat();

        let commandArgs: any[] = [];
        let commandOptions: HashTable<any>;
        let commandExtraArgs: any[] = [];

        let optionDefinitions = this.optionDefinitions;
        let optionDefinitionMap = this.optionDefinitionMap;
        let optionFlagMapping = this.optionFlagMapping;
        let requiredOptionMap: HashTable<boolean>;

        let context: Context = {
            cwd,
            commands: sequence
        };

        if (optionDefinitions) {
            commandOptions = {};
            requiredOptionMap = {};

            for (let definition of optionDefinitions) {
                let {
                    name,
                    required,
                    toggle,
                    default: defaultValue
                } = definition;

                if (required) {
                    requiredOptionMap[name] = true;
                }

                if (toggle) {
                    commandOptions[name] = false;
                } else {
                    commandOptions[name] = defaultValue;
                }
            }
        }

        let paramDefinitions = this.paramDefinitions || [];
        let pendingParamDefinitions = paramDefinitions.concat();

        let paramsDefinition = this.paramsDefinition;
        let paramsType = paramsDefinition && paramsDefinition.type;

        while (args.length) {
            let arg = args.shift();

            if (/^(?:-[h?]|--help)$/.test(arg)) {
                return {
                    help: true
                };
            }

            if (arg[0] === '-') {
                if (arg[1] === '-') {
                    consumeToggleOrOption(arg.substr(2));
                } else {
                    consumeFlags(arg.substr(1))
                }
            } else {
                consumeArgument(arg);
            }
        }

        {
            let expecting = this.requiredParamsNumber;
            let got = commandArgs.length;

            if (got < expecting) {
                let missingArgNames = pendingParamDefinitions
                    .slice(0, expecting - got)
                    .map(definition => `\`${definition.name}\``);

                throw new UsageError(this.helpProvider, `Expecting argument(s) ${missingArgNames.join(', ')}`);
            }
        }

        {
            let missingOptionNames = requiredOptionMap && Object.keys(requiredOptionMap);

            if (missingOptionNames && missingOptionNames.length) {
                throw new UsageError(this.helpProvider, `Missing required option(s) \`${missingOptionNames.join('`, `')}\``);
            }
        }

        for (let definition of pendingParamDefinitions) {
            commandArgs.push(definition.default);
        }

        if (commandExtraArgs.length) {
            if (!paramsDefinition) {
                let expecting = paramDefinitions.length;
                let got = commandExtraArgs.length + expecting;

                throw new UsageError(this.helpProvider, `Expecting ${expecting} parameter(s) at most but got ${got} instead`);
            }
        } else if (paramsDefinition && paramsDefinition.required) {
            throw new UsageError(this.helpProvider, `Expecting at least one element for variadic parameters \`${paramsDefinition.name}\``);
        }

        return {
            args: commandArgs,
            extraArgs: commandExtraArgs,
            options: commandOptions,
            context
        };

        function consumeFlags(flags: string): void {
            for (let i = 0; i < flags.length; i++) {
                let flag = flags[i];

                if (!optionFlagMapping || !optionFlagMapping.hasOwnProperty(flag)) {
                    throw new UsageError(that.helpProvider, `Unknown option flag "${flag}"`);
                }

                let name = optionFlagMapping[flag];
                let definition = optionDefinitionMap[name];

                if (definition.required) {
                    delete requiredOptionMap[name];
                }

                if (definition.toggle) {
                    commandOptions[name] = true;
                } else {
                    if (i !== flags.length - 1) {
                        throw new UsageError(that.helpProvider, 'Only the last flag in a sequence can refer to an option instead of a toggle');
                    }

                    consumeOption(name, definition);
                }
            }
        }

        function consumeToggleOrOption(name: string): void {
            if (!optionDefinitionMap || !optionDefinitionMap.hasOwnProperty(name)) {
                throw new UsageError(that.helpProvider, `Unknown option \`${name}\``);
            }

            let definition = optionDefinitionMap[name];

            if (definition.required) {
                delete requiredOptionMap[name];
            }

            if (definition.toggle) {
                commandOptions[name] = true;
            } else {
                consumeOption(name, definition);
            }
        }

        function consumeOption(name: string, definition: OptionDefinition<any>) {
            let arg = args.shift();

            if (arg === undefined) {
                throw new UsageError(that.helpProvider, `Expecting value for option \`${name}\``);
            }

            if (arg[0] === '-') {
                throw new UsageError(that.helpProvider, `Expecting a value instead of an option or toggle "${arg}" for option \`${name}\``);
            }

            commandOptions[name] = castArgument(arg, definition.type);
        }

        function consumeArgument(arg: string): void {
            if (pendingParamDefinitions.length) {
                let definition = pendingParamDefinitions.shift();
                commandArgs.push(castArgument(arg, definition.type))
            } else {
                commandExtraArgs.push(
                    paramsType ?
                        castArgument(arg, paramsType) :
                        arg
                );
            }
        }

        function castArgument(arg: string, type: Constructor<any>): any {
            switch (type) {
                case String:
                    return arg;
                case Number:
                    return Number(arg);
                case Boolean:
                    if (arg.toLowerCase() === 'false') {
                        return false;
                    } else {
                        let n = Number(arg);
                        return isNaN(n) ? true : Boolean(n);
                    }
                default:
                    if (isStringCastable(type)) {
                        return type.cast(arg, context)
                    } else {
                        return undefined;
                    }
            }
        }
    }
}

export interface HelpProvider {
    getHelp(): HelpInfo;
}

export class UsageError extends ExtendableError implements Printable {
    constructor(
        public helpProvider: HelpProvider,
        message: string
    ) {
        super(message);
    }

    print(stdout: NodeJS.WritableStream, stderr: NodeJS.WritableStream) {
        stderr.write(`${this.message}.\n`);

        this
            .helpProvider
            .getHelp()
            .print(stdout, stderr);
    }
}