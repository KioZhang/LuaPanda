'use strict';
import * as vscode from 'vscode';
import * as Net from 'net';
import * as path from 'path';
import { LuaDebugSession } from './debug/luaDebug';
import { DebugLogger } from './common/logManager';
import { StatusBarManager } from './common/statusBarManager';
import { Tools } from './common/tools';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient';
import { workspace, ExtensionContext } from 'vscode';
import { VisualSetting } from './debug/visualSetting'
import { PathManager } from './common/pathManager';
import {
    ScanOptions,
    WorkspaceScanOptions,
    getEnabledExcludePatterns,
    normalizeMaxDepth
} from './common/scanConfig';

let client: LanguageClient;
let clientFileWatcher: vscode.FileSystemWatcher;
let clientRestartPromise: Promise<void> = Promise.resolve();
let isDeactivating = false;

export function activate(context: ExtensionContext) {
    isDeactivating = false;
    // reloadWindow
    let reloadWindow = vscode.commands.registerCommand('luapanda.reloadLuaDebug', function () {
        vscode.commands.executeCommand("workbench.action.reloadWindow")
    });
    context.subscriptions.push(reloadWindow);
    // force garbage collect
    let LuaGarbageCollect = vscode.commands.registerCommand('luapanda.LuaGarbageCollect', function () {
        for (var [ , instance] of LuaDebugSession.debugSessionArray) {
            instance.LuaGarbageCollect();
        }
        vscode.window.showInformationMessage('Lua Garbage Collect!');
    });
    context.subscriptions.push(LuaGarbageCollect);

    let openSettingsPage = vscode.commands.registerCommand('luapanda.openSettingsPage', function () {
        //先尝试获取数据，如果数据获取失败，给错误提示。
        try{
            let launchData = VisualSetting.getLaunchData(PathManager.rootFolderArray);
            // 和VSCode的交互
            let panel: vscode.WebviewPanel = vscode.window.createWebviewPanel(
                'LuaPanda Setting',
                'LuaPanda Setting',
                vscode.ViewColumn.One,
                {
                    retainContextWhenHidden: true,
                    enableScripts: true
                }
            );
            
            panel.webview.html = Tools.readFileContent(Tools.VSCodeExtensionPath + '/res/web/settings.html');
            // Handle messages from the webview
            panel.webview.onDidReceiveMessage(message => {
                VisualSetting.getWebMessage(message)
            },
                undefined,
                context.subscriptions
            );

            panel.webview.postMessage(launchData);
        }catch (error) {
            DebugLogger.showTips("解析 launch.json 文件失败, 请检查此文件配置项是否异常, 或手动修改 launch.json 中的项目来完成配置!", 2);   
        }
    
    });
    context.subscriptions.push(openSettingsPage);

    const provider = new LuaConfigurationProvider()
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('lua', provider));
    context.subscriptions.push(provider);

    // 静态公共变量赋值
    let pkg = require( context.extensionPath + "/package.json");
    Tools.adapterVersion = pkg.version;
    Tools.VSCodeExtensionPath = context.extensionPath;
    // init log
    DebugLogger.init();
    StatusBarManager.init();

    startLanguageClient(context);
    context.subscriptions.push(workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('lua_analyzer.scan') ||
            event.affectsConfiguration('files.exclude') ||
            event.affectsConfiguration('search.exclude')) {
            restartLanguageClient(context);
        }
    }));
    context.subscriptions.push(workspace.onDidChangeWorkspaceFolders(() => {
        restartLanguageClient(context);
    }));

}

export function deactivate() {
    isDeactivating = true;
    if (clientFileWatcher) {
        clientFileWatcher.dispose();
        clientFileWatcher = undefined;
    }
    Tools.client = undefined;
	return clientRestartPromise.then(() => client ? client.stop() : undefined);
}

/**
 * @brief 获取指定工作区资源的扫描配置。
 * @param resource 用于解析资源级 VS Code 配置的 URI。
 * @return 合并继承规则和 LuaPanda 独立规则后的扫描配置。
 */
function getScanOptions(resource?: vscode.Uri): ScanOptions {
    const scanConfig = workspace.getConfiguration('lua_analyzer.scan', resource);
    let excludePatterns: string[] = [];
    if (scanConfig.get<boolean>('inheritFilesExclude', true)) {
        const filesExclude = workspace.getConfiguration('files', resource).get<any>('exclude', {});
        excludePatterns = excludePatterns.concat(getEnabledExcludePatterns(filesExclude));
    }
    if (scanConfig.get<boolean>('inheritSearchExclude', true)) {
        const searchExclude = workspace.getConfiguration('search', resource).get<any>('exclude', {});
        excludePatterns = excludePatterns.concat(getEnabledExcludePatterns(searchExclude));
    }
    const customExclude = scanConfig.get<string[]>('exclude', []);
    if (Array.isArray(customExclude)) {
        excludePatterns = excludePatterns.concat(customExclude);
    }
    return {
        excludePatterns: Array.from(new Set(excludePatterns)),
        maxDepth: normalizeMaxDepth(scanConfig.get<number>('maxDepth', 5)),
        basePath: resource && resource.fsPath
    };
}

/**
 * @brief 获取所有工作区文件夹的扫描配置。
 * @return 以工作区根路径为键的扫描配置。
 */
function getWorkspaceScanOptions(): WorkspaceScanOptions {
    const result: WorkspaceScanOptions = {};
    for (const folder of workspace.workspaceFolders || []) {
        result[folder.uri.fsPath] = getScanOptions(folder.uri);
    }
    return result;
}

function startLanguageClient(context: ExtensionContext): void {
    const serverModule = context.asAbsolutePath(path.join('out', 'code', 'server', 'server.js'));
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };
    const serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions
        }
    };

    clientFileWatcher = workspace.createFileSystemWatcher('**/.clientrc');
    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ scheme: 'file', language: 'lua' }],
        synchronize: {
            fileEvents: clientFileWatcher
        },
        initializationOptions: {
            workspaceScanOptions: getWorkspaceScanOptions()
        }
    };

    const currentClient = new LanguageClient(
        'lua_analyzer',
        'Lua Analyzer',
        serverOptions,
        clientOptions
    );
    client = currentClient;
    currentClient.start();
    currentClient.onReady().then(() => {
        if (client !== currentClient || isDeactivating) {
            return;
        }
        Tools.client = currentClient;
        currentClient.onNotification("setRootFolders", setRootFolders);
        currentClient.onNotification("showProgress", showProgress);
        currentClient.onNotification("showErrorMessage", showErrorMessage);
        currentClient.onNotification("showWarningMessage", showWarningMessage);
        currentClient.onNotification("showInformationMessage", showInformationMessage);
    }, () => undefined);
}

function restartLanguageClient(context: ExtensionContext): void {
    clientRestartPromise = clientRestartPromise.then(() => {
        const previousClient = client;
        client = undefined;
        Tools.client = undefined;
        if (clientFileWatcher) {
            clientFileWatcher.dispose();
            clientFileWatcher = undefined;
        }
        return previousClient ? previousClient.stop() : undefined;
    }).then(() => {
        if (!isDeactivating) {
            startLanguageClient(context);
        }
    }).catch(error => {
        vscode.window.showErrorMessage("LuaPanda 重新加载扫描配置失败: " + error.message);
    });
}

// debug启动时的配置项处理
class LuaConfigurationProvider implements vscode.DebugConfigurationProvider {
    private _server?: Net.Server;
    private static RunFileTerminal;
    resolveDebugConfiguration(folder: vscode.WorkspaceFolder | undefined, config: vscode.DebugConfiguration, token?: vscode.CancellationToken): vscode.ProviderResult<vscode.DebugConfiguration> {
        // if launch.json is missing or empty
        if (!config.type && !config.name) {
            const editor = vscode.window.activeTextEditor;
            if (editor && editor.document.languageId === 'lua') {
                vscode.window.showInformationMessage('请先正确配置launch文件!');
                config.type = 'lua';
                config.name = 'LuaPanda';
                config.request = 'launch';
            }
        }

        // 不调试而直接运行当前文件
        if(config.noDebug){
            // 获取活跃窗口
            let retObject = Tools.getVSCodeAvtiveFilePath();
            if( retObject["retCode"] !== 0 ){
                DebugLogger.DebuggerInfo(retObject["retMsg"]);
                return;
            }
            let filePath = retObject["filePath"];

            if(LuaConfigurationProvider.RunFileTerminal){
                LuaConfigurationProvider.RunFileTerminal.dispose();
            }
            LuaConfigurationProvider.RunFileTerminal = vscode.window.createTerminal({
                name: "Run Lua File (LuaPanda)",
                env: {}, 
            });

            // 把路径加入package.path
            let path = require("path");
            let pathCMD = "'";
            let pathArr = Tools.VSCodeExtensionPath.split( path.sep );
            let stdPath = pathArr.join('/');
            pathCMD = pathCMD + stdPath + "/Debugger/?.lua;"
            pathCMD = pathCMD + config.packagePath.join(';')
            pathCMD = pathCMD + "'";
            //拼接命令
            pathCMD = " \"package.path = " + pathCMD + ".. package.path;\" ";
            let doFileCMD =  filePath;
            let runCMD = pathCMD + doFileCMD;

            let LuaCMD;
            if(config.luaPath && config.luaPath !== ''){
                LuaCMD = config.luaPath + " -e "
            }else{
                LuaCMD = "lua -e ";
            }
            LuaConfigurationProvider.RunFileTerminal.sendText( LuaCMD + runCMD , true);
            LuaConfigurationProvider.RunFileTerminal.show();
            return ;
        }

        // 旧版本的launch.json中没有tag, 利用name给tag赋值
        if(config.tag == undefined){
            if(config.name === "LuaPanda"){
                config.tag = "normal"
            }
            else if(config.name === "LuaPanda-Attach"){
                config.tag = "attach"
            }
            // config.name === "LuaPanda-DebugFile" 是对 3.1.0 版本的兼容
            else if(config.name === "LuaPanda-IndependentFile" || config.name === "LuaPanda-DebugFile" ){
                config.tag = "independent_file"
            }

        }

        // 关于打开调试控制台的自动设置
        if(config.tag === "independent_file"){
            if(!config.internalConsoleOptions){
                config.internalConsoleOptions = "neverOpen";
            }
        }else{
            if(!config.internalConsoleOptions){
                config.internalConsoleOptions = "openOnSessionStart";
            }
        }

        // rootFolder 固定为 ${workspaceFolder}, 用来查找本项目的launch.json.
        config.rootFolder = '${workspaceFolder}';
        config.__luaPandaScanOptions = getScanOptions(folder && folder.uri);

        if (!config.TempFilePath) {
            config.TempFilePath = '${workspaceFolder}';
        }

        // 开发模式设置
        if( config.DevelopmentMode !== true ){
            config.DevelopmentMode = false;
        }

        // attach 模式这里不用赋初值，后面会拷贝luapanda模式的配置信息
        if(config.tag !== "attach"){
            if(!config.program){
                config.program = '';
            }

            if(config.packagePath == undefined){
                config.packagePath = [];
            }
            
            if(config.truncatedOPath == undefined){
                config.truncatedOPath = "";
            }

            if(config.distinguishSameNameFile == undefined){
                config.distinguishSameNameFile = false;
            }

            if(config.dbCheckBreakpoint == undefined){
                config.dbCheckBreakpoint = false;
            }

            if(!config.args){
                config.args = new Array<string>();
            }

            if(config.autoPathMode == undefined){
                // 默认使用自动路径模式
                config.autoPathMode = true;
            }
            
            if (!config.cwd) {
                config.cwd = '${workspaceFolder}';
            }

            if (!config.luaFileExtension) {
                config.luaFileExtension = '';
            }else{
                // luaFileExtension 兼容 ".lua" or "lua"
                let firseLetter = config.luaFileExtension.substr(0, 1);
                if(firseLetter === '.'){
                    config.luaFileExtension =  config.luaFileExtension.substr(1);
                }
            }

            if (config.stopOnEntry == undefined) {
                config.stopOnEntry = true;
            }
    
            if (config.pathCaseSensitivity == undefined) {
                config.pathCaseSensitivity = false;
            }
    
            if (config.connectionPort == undefined) {
                config.connectionPort = 8818;
            }
    
            if (config.logLevel == undefined) {
                config.logLevel = 1;
            }
    
            if (config.autoReconnect == undefined) {
                // 未配置时默认等待下一个 Lua 进程连接。
                config.autoReconnect = true;
            }
    
            if (config.updateTips == undefined) {
                config.updateTips = true;
            }
    
            if (config.useCHook == undefined) {
                config.useCHook = true;
            }
    
            if (config.isNeedB64EncodeStr == undefined) {
                config.isNeedB64EncodeStr = true;
            }

            if (config.VSCodeAsClient == undefined) {
                config.VSCodeAsClient = false;
            }

            if (config.connectionIP == undefined) {
                config.connectionIP = "127.0.0.1";
            }
        }
        
        if (!this._server) {
            this._server = Net.createServer(socket => {
                const session = new LuaDebugSession();
                session.setRunAsServer(true);
                session.start(<NodeJS.ReadableStream>socket, socket);
            }).listen(0);
        }
        // make VS Code connect to debug server instead of launching debug adapter
        config.debugServer = this._server.address()['port'];
        return config;
    }

    dispose() {
        if (this._server) {
            this._server.close();
        }
    }
}

// code server 消息回调函数
function showProgress(message: string) {
    StatusBarManager.showSetting(message);
}

function setRootFolders(...rootFolders) {
    PathManager.rootFolderArray = rootFolders;
}

function showErrorMessage(str: string) {
    vscode.window.showErrorMessage(str);
}

function showWarningMessage(str: string) {
    vscode.window.showWarningMessage(str);
}

function showInformationMessage(str: string) {
    vscode.window.showInformationMessage(str);
}
