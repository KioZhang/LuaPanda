import * as fs from 'fs';
import * as path from 'path';

interface ReaderOptions {
    sync?: boolean;
    recursive?: boolean;
    reverse?: boolean;
    sort?: boolean | string;
    shortName?: boolean | string;
    basePath?: string;
    excludeHidden?: boolean;
    match?: RegExp | string[];
    exclude?: RegExp | string[];
    matchDir?: RegExp | string[];
    excludeDir?: RegExp | string[];
    filter?: (filename: string) => boolean;
    encoding?: BufferEncoding;
    doneOnErr?: boolean;
    valuetizer?: (stat: fs.Stats, shortName: string, fullPath: string, isDir: boolean) => any;
}

interface ScanResults {
    files: any[];
    dirs: any[];
}

function isLoopError(error): boolean {
    return error && (error.code === 'ELOOP' || error.code === 'ENOENT');
}

function sortEntries(entries: string[], options: ReaderOptions): string[] {
    if (options.reverse === true ||
        (typeof options.sort === 'string' && /reverse|desc/i.test(options.sort))) {
        return entries.sort().reverse();
    }
    return options.sort === false ? entries : entries.sort();
}

function matches(value: string, matcher: RegExp | string[]): boolean {
    if (Array.isArray(matcher)) {
        return matcher.indexOf(value) >= 0;
    }
    matcher.lastIndex = 0;
    return matcher.test(value);
}

function valueForEntry(options: ReaderOptions, stat: fs.Stats, name: string,
    fullPath: string, isDir: boolean, rootPath: string) {
    if (options.valuetizer) {
        return options.valuetizer(stat, name, fullPath, isDir);
    }
    if (options.shortName === 'relative') {
        return path.relative(options.basePath || rootPath, fullPath);
    }
    return options.shortName ? name : fullPath;
}

function scanDirectorySync(dirPath: string, type: string, options: ReaderOptions,
    rootPath: string, visitedRealPaths: Set<string>, results: ScanResults): void {
    let realPath: string;
    try {
        realPath = fs.realpathSync(dirPath);
    } catch (error) {
        if (isLoopError(error)) {
            return;
        }
        throw error;
    }

    // 真实目录只扫描一次，允许进入普通符号链接并阻断目录环。
    if (visitedRealPaths.has(realPath)) {
        return;
    }
    visitedRealPaths.add(realPath);

    const entries = sortEntries(fs.readdirSync(dirPath).map(entry => entry.toString()), options);
    for (const name of entries) {
        const fullPath = path.join(dirPath, name);
        let stat: fs.Stats;
        try {
            const linkStat = fs.lstatSync(fullPath);
            stat = linkStat.isSymbolicLink() ? fs.statSync(fullPath) : linkStat;
        } catch (error) {
            if (isLoopError(error)) {
                continue;
            }
            throw error;
        }

        const isDir = stat.isDirectory();
        const value = valueForEntry(options, stat, name, fullPath, isDir, rootPath);
        if (value == null) {
            continue;
        }

        if (isDir) {
            if (type !== 'file') {
                results.dirs.push(value);
            }
            if (options.recursive !== false) {
                scanDirectorySync(fullPath, type, options, rootPath, visitedRealPaths, results);
            }
        } else if (type !== 'dir' && !(options.excludeHidden && /^\./.test(name))) {
            results.files.push(value);
        }
    }
}

function scanFilesSync(dirPath: string, type: string, options: ReaderOptions) {
    // 根目录保持使用 statSync，子项再通过 lstatSync 识别符号链接。
    const rootStat = fs.statSync(dirPath);
    if (!rootStat.isDirectory()) {
        return type === 'all' ? {files: [], dirs: []} : [];
    }

    const results: ScanResults = {files: [], dirs: []};
    scanDirectorySync(dirPath, type, options, dirPath, new Set<string>(), results);
    if (type === 'all') {
        return results;
    }
    if (type === 'combine') {
        return results.files.concat(results.dirs);
    }
    return type === 'dir' ? results.dirs : results.files;
}

/**
 * @brief 扫描目录中的文件或子目录。
 * @param dirPath 根目录路径。
 * @param typeOrOptions 结果类型或扫描选项。
 * @param callbackOrOptions 完成回调或扫描选项。
 * @param explicitOptions 扫描选项。
 * @return 同步模式返回路径数组，异步模式无返回值。
 */
export function files(dirPath: string, typeOrOptions?: any,
    callbackOrOptions?: any, explicitOptions?: ReaderOptions): any {
    let type = 'file';
    let callback;
    let options: ReaderOptions = {};

    if (typeof typeOrOptions === 'string') {
        type = typeOrOptions;
        callback = callbackOrOptions;
        options = explicitOptions || {};
    } else {
        callback = typeof typeOrOptions === 'function' ? typeOrOptions : callbackOrOptions;
        options = typeof typeOrOptions === 'object' && typeOrOptions ? typeOrOptions : {};
    }

    if (options.sync) {
        return scanFilesSync(dirPath, type, options);
    }

    setImmediate(() => {
        try {
            const result = scanFilesSync(dirPath, type, Object.assign({}, options, {sync: true}));
            if (typeof callback === 'function') {
                callback(null, result);
            }
        } catch (error) {
            if (typeof callback === 'function') {
                callback(error);
            }
        }
    });
}

function readDirectory(dirPath: string, options: ReaderOptions, callback,
    complete, filesRead: string[], visitedRealPaths: Set<string>): void {
    fs.realpath(dirPath, (realPathError, realPath) => {
        if (realPathError) {
            return isLoopError(realPathError) ? complete(null) : complete(realPathError);
        }
        if (visitedRealPaths.has(realPath)) {
            return complete(null);
        }
        visitedRealPaths.add(realPath);

        fs.readdir(dirPath, (readError, rawEntries) => {
            if (readError) {
                if (readError.code === 'EACCES' || options.doneOnErr === false) {
                    return complete(null);
                }
                return complete(readError);
            }

            const entries = sortEntries(rawEntries.map(entry => entry.toString()), options);
            let index = 0;
            const next = () => {
                const name = entries[index++];
                if (name === undefined) {
                    return complete(null);
                }

                const fullPath = path.join(dirPath, name);
                fs.lstat(fullPath, (linkError, linkStat) => {
                    if (linkError) {
                        return isLoopError(linkError) ? next() : complete(linkError);
                    }
                    const onStat = (statError, stat: fs.Stats) => {
                        if (statError) {
                            return isLoopError(statError) ? next() : complete(statError);
                        }
                        if (stat.isDirectory()) {
                            if (options.recursive === false ||
                                (options.matchDir && !matches(name, options.matchDir)) ||
                                (options.excludeDir && matches(name, options.excludeDir))) {
                                return next();
                            }
                            return readDirectory(fullPath, options, callback, error => {
                                return error ? complete(error) : next();
                            }, filesRead, visitedRealPaths);
                        }
                        if (!stat.isFile() ||
                            (options.match && !matches(name, options.match)) ||
                            (options.exclude && matches(name, options.exclude)) ||
                            (options.filter && !options.filter(name))) {
                            return next();
                        }

                        const reportedPath = options.shortName ? name : fullPath;
                        filesRead.push(reportedPath);
                        fs.readFile(fullPath, options.encoding || 'utf8', (fileError, content) => {
                            if (fileError) {
                                if (fileError.code === 'EACCES' || options.doneOnErr === false) {
                                    return next();
                                }
                                return complete(fileError);
                            }
                            if (callback.length > 3) {
                                callback(null, content, reportedPath, next);
                            } else {
                                callback(null, content, next);
                            }
                        });
                    };

                    if (linkStat.isSymbolicLink()) {
                        fs.stat(fullPath, onStat);
                    } else {
                        onStat(null, linkStat);
                    }
                });
            };
            next();
        });
    });
}

/**
 * @brief 依次读取目录中的文件内容。
 * @param dirPath 根目录路径。
 * @param optionsOrCallback 读取选项或文件回调。
 * @param callbackOrComplete 文件回调或完成回调。
 * @param explicitComplete 完成回调。
 * @return 无返回值。
 */
export function readFiles(dirPath: string, optionsOrCallback: any,
    callbackOrComplete?: any, explicitComplete?: any): void {
    let options: ReaderOptions;
    let callback;
    let complete;
    if (typeof optionsOrCallback === 'function') {
        options = {};
        callback = optionsOrCallback;
        complete = callbackOrComplete;
    } else {
        options = typeof optionsOrCallback === 'string'
            ? {encoding: optionsOrCallback}
            : Object.assign({}, optionsOrCallback || {});
        callback = callbackOrComplete;
        complete = explicitComplete;
    }

    options.recursive = options.recursive !== false;
    options.doneOnErr = options.doneOnErr !== false;
    const filesRead: string[] = [];
    readDirectory(dirPath, options, callback, error => {
        if (typeof complete === 'function') {
            complete(error || null, filesRead);
        }
    }, filesRead, new Set<string>());
}
