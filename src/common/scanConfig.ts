const minimatch = require('minimatch');

export const DEFAULT_SCAN_MAX_DEPTH = 5;

export interface ScanOptions {
    excludePatterns: string[];
    maxDepth: number;
    basePath?: string;
}

export interface WorkspaceScanOptions {
    [rootPath: string]: ScanOptions;
}

/**
 * @brief 收集 VS Code 排除配置中已启用的 glob。
 * @param excludeSetting files.exclude 或 search.exclude 配置对象。
 * @return 值为 true 的 glob 列表；条件排除规则不会被采用。
 */
export function getEnabledExcludePatterns(excludeSetting: any): string[] {
    if (!excludeSetting || typeof excludeSetting !== 'object') {
        return [];
    }
    return Object.keys(excludeSetting).filter(pattern => excludeSetting[pattern] === true);
}

/**
 * @brief 规范化扫描深度。
 * @param maxDepth 用户配置的最大扫描深度。
 * @return 非负整数；无效值返回默认深度。
 */
export function normalizeMaxDepth(maxDepth: any): number {
    if (typeof maxDepth !== 'number' || !isFinite(maxDepth) || maxDepth < 0) {
        return DEFAULT_SCAN_MAX_DEPTH;
    }
    return Math.floor(maxDepth);
}

/**
 * @brief 创建工作区相对路径排除匹配器。
 * @param patterns VS Code glob 风格的排除规则。
 * @return 路径命中任一规则时返回 true 的函数。
 */
export function createExcludePathMatcher(patterns: string[]): (relativePath: string, isDir: boolean) => boolean {
    const matchers = (Array.isArray(patterns) ? patterns : [])
        .filter(pattern => typeof pattern === 'string' && pattern.trim() !== '')
        .map(pattern => pattern.trim().replace(/\\/g, '/'))
        .map(pattern => {
            try {
                return new minimatch.Minimatch(pattern, {
                    dot: true,
                    matchBase: false,
                    nocomment: true,
                    nonegate: true,
                    nocase: process.platform === 'win32'
                });
            } catch (_error) {
                return null;
            }
        })
        .filter(matcher => matcher !== null);

    return (relativePath: string, isDir: boolean): boolean => {
        const normalizedPath = relativePath.replace(/\\/g, '/');
        return matchers.some(matcher => matcher.match(normalizedPath) ||
            (isDir && matcher.match(normalizedPath + '/')));
    };
}

/**
 * @brief 将扫描配置转换为 pathReader 选项。
 * @param options 扫描配置。
 * @return 可合并到 pathReader 的最大深度和排除回调。
 */
export function createReaderScanOptions(options: ScanOptions): {
    maxDepth: number;
    excludeBasePath?: string;
    excludePath: (relativePath: string, isDir: boolean) => boolean;
} {
    const scanOptions = options || {
        excludePatterns: [],
        maxDepth: DEFAULT_SCAN_MAX_DEPTH
    };
    return {
        maxDepth: normalizeMaxDepth(scanOptions.maxDepth),
        excludeBasePath: scanOptions.basePath,
        excludePath: createExcludePathMatcher(scanOptions.excludePatterns)
    };
}
