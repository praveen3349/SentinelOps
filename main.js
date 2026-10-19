const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const Store = require('electron-store');

const { cloneRepository, getGitBranches } = require('./src/gitService');
const { detectProject } = require('./src/detector');
const { aiAnalyzeRepository, aiSolveError } = require('./src/aiAnalyzer');
const { getDockerStatus, dockerSpec, generateDockerAssets, sanitizeName } = require('./src/dockerService');
const { generatePipelineAssets } = require('./src/pipelineService');
const { recommendation, generateDeploymentAssets } = require('./src/deploymentService');

const store = new Store({
  name: 'sentinelops-app-data',
  defaults: {
    projects: [],
    credentials: {},
    apiConfig: { provider: 'gemini', apiKey: '' }
  }
});

let mainWindow;
let activeChildProcess = null;
const projectProcesses = new Map();
const dockerProcesses = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 650,
    title: 'SentinelOps: Autonomous AI DevOps Platform',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------- IPC: choose a destination folder ----------
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// ---------- IPC: credentials & API keys ----------
ipcMain.handle('get-credentials', (event, provider) => {
  const credentials = store.get('credentials', {});
  return credentials[provider] || null;
});

ipcMain.handle('save-credentials', (event, { provider, credentials }) => {
  const all = store.get('credentials', {});
  all[provider] = credentials;
  store.set('credentials', all);
  return true;
});

ipcMain.handle('get-api-config', () => {
  return store.get('apiConfig', { provider: 'gemini', apiKey: '' });
});

ipcMain.handle('save-api-config', (event, config) => {
  store.set('apiConfig', config);
  return true;
});

// ---------- IPC: clone repo ----------
ipcMain.handle('clone-repo', async (event, { repoUrl, provider, destParentPath, useSavedCredentials }) => {
  let credentials = null;
  if (useSavedCredentials) {
    const all = store.get('credentials', {});
    credentials = all[provider] || null;
  }

  const result = await cloneRepository({
    repoUrl,
    provider,
    destParentPath,
    credentials,
    onProgress: (msg) => {
      event.sender.send('clone-progress', msg);
    }
  });

  if (result.success) {
    const detection = detectProject(result.targetPath);
    const gitInfo = await getGitBranches(result.targetPath);
    const apiConfig = store.get('apiConfig', {});
    const aiAnalysis = await aiAnalyzeRepository({ rootPath: result.targetPath, gitInfo, apiConfig });

    const project = {
      id: Date.now().toString(),
      name: path.basename(result.targetPath),
      repoUrl,
      provider,
      path: result.targetPath,
      addedAt: new Date().toISOString(),
      detection,
      gitInfo,
      aiAnalysis
    };

    const projects = store.get('projects', []);
    projects.unshift(project);
    store.set('projects', projects);

    return { success: true, project };
  }

  return result;
});

ipcMain.handle('clone-repo-with-auth', async (event, { repoUrl, provider, destParentPath, credentials, remember }) => {
  const result = await cloneRepository({
    repoUrl,
    provider,
    destParentPath,
    credentials,
    onProgress: (msg) => {
      event.sender.send('clone-progress', msg);
    }
  });

  if (remember && result.success) {
    const all = store.get('credentials', {});
    all[provider] = credentials;
    store.set('credentials', all);
  }

  if (result.success) {
    const detection = detectProject(result.targetPath);
    const gitInfo = await getGitBranches(result.targetPath);
    const apiConfig = store.get('apiConfig', {});
    const aiAnalysis = await aiAnalyzeRepository({ rootPath: result.targetPath, gitInfo, apiConfig });

    const project = {
      id: Date.now().toString(),
      name: path.basename(result.targetPath),
      repoUrl,
      provider,
      path: result.targetPath,
      addedAt: new Date().toISOString(),
      detection,
      gitInfo,
      aiAnalysis
    };

    const projects = store.get('projects', []);
    projects.unshift(project);
    store.set('projects', projects);

    return { success: true, project };
  }

  return result;
});

// ---------- IPC: get saved projects & management ----------
ipcMain.handle('get-projects', () => {
  return store.get('projects', []);
});

ipcMain.handle('remove-project', (event, projectId) => {
  const projects = store.get('projects', []).filter((p) => p.id !== projectId);
  store.set('projects', projects);
  return projects;
});

// Deletes only a directory belonging to a project saved by this application.
// This endpoint deliberately refuses drive roots and unknown projects.
ipcMain.handle('delete-cloned-project', async (event, projectId) => {
  const projects = store.get('projects', []);
  const project = projects.find((p) => p.id === projectId);
  if (!project || !project.path) return { success: false, error: 'Managed project not found.' };

  const resolvedPath = path.resolve(project.path);
  if (resolvedPath === path.parse(resolvedPath).root || !fs.existsSync(resolvedPath)) {
    return { success: false, error: 'The project folder is unavailable or is not safe to remove.' };
  }

  const running = [...projectProcesses.entries()].filter(([, item]) => item.projectId === projectId);
  for (const [key, item] of running) {
    try { item.process.kill(); } catch (e) {}
    projectProcesses.delete(key);
  }

  try {
    await fs.promises.rm(resolvedPath, { recursive: true, force: false, maxRetries: 2 });
    const updatedProjects = projects.filter((p) => p.id !== projectId);
    store.set('projects', updatedProjects);
    return { success: true, projects: updatedProjects };
  } catch (error) {
    return { success: false, error: `Could not delete the cloned folder: ${error.message}` };
  }
});

// Persist user-approved stack and deployment decisions. Detection is always a
// recommendation; this makes the orchestration plan explicitly editable.
ipcMain.handle('update-project-config', (event, { id, config }) => {
  const projects = store.get('projects', []);
  const project = projects.find((p) => p.id === id);
  if (!project) return null;
  project.orchestration = { ...(project.orchestration || {}), ...config, updatedAt: new Date().toISOString() };
  store.set('projects', projects);
  return project;
});

// ---------- IPC: Docker workspace ----------
ipcMain.handle('get-docker-status', async () => getDockerStatus());

function projectDockerServices(project) {
  const analysis = { ...(project?.aiAnalysis || {}), ...(project?.orchestration?.detection || {}) };
  const services = analysis.services || [];
  if (services.length) return services;
  if (!analysis.type) return [];
  return [{ id: 'root', name: analysis.framework || analysis.type, directory: '.', type: analysis.type, framework: analysis.framework, packageManager: analysis.packageManager, runCommand: analysis.runCommand, port: analysis.port }];
}

function startDockerCommand(event, project, service, action) {
  const spec = dockerSpec(service);
  const serviceName = sanitizeName(service.id || service.name);
  const image = `${sanitizeName(project.name)}-${serviceName}:local`;
  const container = `sentinelops-${sanitizeName(project.name)}-${serviceName}`;
  const directory = path.resolve(project.path, service.directory || '.');
  const dockerfile = path.join(directory, '.sentinelops', 'Dockerfile');
  let args;
  if (action === 'pull') args = ['pull', spec.baseImage];
  else if (action === 'build') args = ['build', '--pull', '-t', image, '-f', dockerfile, directory];
  else if (action === 'run') args = ['run', '-d', '--rm', '--name', container, ...(spec.port ? ['-p', `${spec.port}:${spec.port}`] : []), image];
  else throw new Error('Unsupported Docker action.');
  const key = `${project.id}:${service.id}:${action}`;
  event.sender.send('docker-task-output', { projectId: project.id, serviceId: service.id, action, data: `\n$ docker ${args.join(' ')}\n\n` });
  const child = spawn('docker', args, { windowsHide: true });
  dockerProcesses.set(key, child);
  const emit = (data) => event.sender.send('docker-task-output', { projectId: project.id, serviceId: service.id, action, data: data.toString() });
  child.stdout.on('data', emit); child.stderr.on('data', emit);
  child.on('error', (error) => emit(`\n[Docker error: ${error.message}]\n`));
  child.on('close', (code) => { dockerProcesses.delete(key); event.sender.send('docker-task-exit', { projectId: project.id, serviceId: service.id, action, code, image, container, url: spec.port ? `http://localhost:${spec.port}` : '' }); });
  return { success: true, image, container, baseImage: spec.baseImage, url: spec.port ? `http://localhost:${spec.port}` : '' };
}

ipcMain.handle('prepare-docker-project', async (event, projectId) => {
  const project = store.get('projects', []).find((item) => item.id === projectId);
  if (!project) return { success: false, error: 'Managed project not found.' };
  if (!project.orchestration?.localValidation?.passed) return { success: false, error: 'Run and confirm the application locally before generating container assets.' };
  try {
    const services = projectDockerServices(project);
    if (!services.length) return { success: false, error: 'No runnable service is available. Confirm the technology profile first.' };
    const assets = generateDockerAssets(project, services);
    project.orchestration = { ...(project.orchestration || {}), docker: { ...assets, generatedAt: new Date().toISOString() } };
    const projects = store.get('projects', []); store.set('projects', projects);
    return { success: true, project, assets };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('confirm-local-validation', (event, projectId) => {
  const projects = store.get('projects', []);
  const project = projects.find((item) => item.id === projectId);
  if (!project) return null;
  project.orchestration = { ...(project.orchestration || {}), localValidation: { passed: true, confirmedAt: new Date().toISOString() } };
  store.set('projects', projects);
  return project;
});

ipcMain.handle('generate-pipeline-assets', async (event, { projectId, provider, observability }) => {
  const projects = store.get('projects', []);
  const project = projects.find((item) => item.id === projectId);
  if (!project) return { success: false, error: 'Managed project not found.' };
  if (!project.orchestration?.localValidation?.passed) return { success: false, error: 'Confirm local validation before generating a deployment pipeline.' };
  try {
    const services = projectDockerServices(project);
    if (!services.length) return { success: false, error: 'No runnable service is available. Confirm the technology profile first.' };
    const docker = generateDockerAssets(project, services);
    const result = generatePipelineAssets(project, services, { provider, observability });
    project.orchestration = { ...(project.orchestration || {}), docker: { ...docker, generatedAt: new Date().toISOString() }, delivery: { provider, observability, generatedAt: new Date().toISOString(), ...result } };
    store.set('projects', projects);
    return { success: true, project, docker, ...result };
  } catch (error) { return { success: false, error: error.message }; }
});

ipcMain.handle('get-deployment-recommendation', (event, projectId) => {
  const project = store.get('projects', []).find((item) => item.id === projectId);
  if (!project) return null;
  return recommendation(projectDockerServices(project));
});

ipcMain.handle('generate-deployment-assets', async (event, { projectId, profile, scale }) => {
  const projects = store.get('projects', []);
  const project = projects.find((item) => item.id === projectId);
  if (!project) return { success: false, error: 'Managed project not found.' };
  if (!project.orchestration?.localValidation?.passed) return { success: false, error: 'Confirm local validation before generating deployment assets.' };
  try {
    const services = projectDockerServices(project);
    if (!services.length) return { success: false, error: 'No runnable service is available. Confirm the technology profile first.' };
    const generated = generateDeploymentAssets(project, services, { profile, ...scale });
    project.orchestration = { ...(project.orchestration || {}), profile, deployment: { profile, generatedAt: new Date().toISOString(), ...generated } };
    store.set('projects', projects);
    return { success: true, project, ...generated };
  } catch (error) { return { success: false, error: error.message }; }
});

function probeUrl(url, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const started = Date.now();
    let target;
    try { target = new URL(url); } catch (error) { resolve({ url, status: 'unknown', error: 'Invalid URL' }); return; }
    const transport = target.protocol === 'https:' ? require('https') : require('http');
    const request = transport.get(target, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve({ url, status: response.statusCode >= 200 && response.statusCode < 500 ? 'healthy' : 'unhealthy', statusCode: response.statusCode, latencyMs: Date.now() - started });
    });
    request.on('timeout', () => request.destroy(new Error('Timed out')));
    request.on('error', (error) => resolve({ url, status: 'unreachable', latencyMs: Date.now() - started, error: error.message }));
  });
}

ipcMain.handle('probe-project-health', async (event, projectId) => {
  const project = store.get('projects', []).find((item) => item.id === projectId);
  if (!project) return [];
  const checks = projectDockerServices(project).filter((service) => service.url).map(async (service) => ({ serviceId: service.id, serviceName: service.name, ...(await probeUrl(service.url)) }));
  return Promise.all(checks);
});

ipcMain.handle('run-docker-task', async (event, { projectId, serviceId, action }) => {
  const status = await getDockerStatus();
  if (!status.running) return { success: false, error: status.message };
  const project = store.get('projects', []).find((item) => item.id === projectId);
  const service = projectDockerServices(project).find((item) => item.id === serviceId);
  if (!project || !service) return { success: false, error: 'The selected Docker service is no longer available.' };
  if (['build', 'run'].includes(action) && !fs.existsSync(path.join(project.path, service.directory || '.', '.sentinelops', 'Dockerfile'))) return { success: false, error: 'Generate Docker assets before building or running.' };
  try { return startDockerCommand(event, project, service, action); } catch (error) { return { success: false, error: error.message }; }
});

// ---------- IPC: File Tree & Code Viewing ----------
function buildFileTree(dirPath, relativeDir = '') {
  const IGNORE_DIRS = new Set(['.git', 'node_modules', 'venv', '__pycache__', '.idea', '.vscode', 'dist', 'build']);
  let items = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;

      const fullPath = path.join(dirPath, entry.name);
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        items.push({
          name: entry.name,
          path: fullPath,
          relativePath: relPath,
          isDir: true,
          children: buildFileTree(fullPath, relPath)
        });
      } else {
        items.push({
          name: entry.name,
          path: fullPath,
          relativePath: relPath,
          isDir: false
        });
      }
    }
  } catch (e) {}

  return items.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
}

ipcMain.handle('get-file-tree', (event, projectPath) => {
  if (!projectPath || !fs.existsSync(projectPath)) return null;
  return buildFileTree(projectPath);
});

ipcMain.handle('read-file-content', (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return { error: 'File does not exist' };
    const stat = fs.statSync(filePath);
    if (stat.size > 2 * 1024 * 1024) return { content: '(File is larger than 2MB and cannot be previewed directly.)' };
    const content = fs.readFileSync(filePath, 'utf8');
    return { content };
  } catch (err) {
    return { error: err.message };
  }
});

// ---------- IPC: AI Analysis & Error Solver ----------
ipcMain.handle('ai-analyze-project', async (event, projectId) => {
  const projects = store.get('projects', []);
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;

  const gitInfo = await getGitBranches(project.path);
  const apiConfig = store.get('apiConfig', {});
  const aiAnalysis = await aiAnalyzeRepository({ rootPath: project.path, gitInfo, apiConfig });

  project.gitInfo = gitInfo;
  project.aiAnalysis = aiAnalysis;

  store.set('projects', projects);
  return project;
});

ipcMain.handle('ai-solve-error', async (event, { errorLog, projectId }) => {
  const projects = store.get('projects', []);
  const project = projects.find((p) => p.id === projectId) || {};
  const apiConfig = store.get('apiConfig', {});
  return await aiSolveError({ errorLog, projectInfo: project, apiConfig });
});

// ---------- IPC: Command Execution Console & Process Tree Termination ----------
ipcMain.handle('run-terminal-command', (event, { command, cwd }) => {
  if (activeChildProcess && activeChildProcess.pid) {
    try {
      if (process.platform === 'win32') {
        exec(`taskkill /F /T /PID ${activeChildProcess.pid}`);
      } else {
        activeChildProcess.kill('SIGKILL');
      }
    } catch (e) {}
    activeChildProcess = null;
  }

  event.sender.send('terminal-output', `\n$ ${command}\n\n`);

  try {
    activeChildProcess = spawn(command, {
      shell: true,
      cwd: cwd || process.cwd(),
      env: { ...process.env, FORCE_COLOR: '1' }
    });

    activeChildProcess.stdout.on('data', (data) => {
      event.sender.send('terminal-output', data.toString());
    });

    activeChildProcess.stderr.on('data', (data) => {
      event.sender.send('terminal-output', data.toString());
    });

    activeChildProcess.on('close', (code) => {
      event.sender.send('terminal-output', `\n[Process exited with code ${code}]\n`);
      event.sender.send('terminal-exit', code);
      activeChildProcess = null;
    });

    activeChildProcess.on('error', (err) => {
      event.sender.send('terminal-output', `\n[Process error: ${err.message}]\n`);
      activeChildProcess = null;
    });

    return { success: true };
  } catch (err) {
    event.sender.send('terminal-output', `\n[Failed to launch process: ${err.message}]\n`);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-terminal-command', (event) => {
  if (activeChildProcess && activeChildProcess.pid) {
    const pid = activeChildProcess.pid;
    try {
      if (process.platform === 'win32') {
        exec(`taskkill /F /T /PID ${pid}`);
      } else {
        activeChildProcess.kill('SIGKILL');
      }
      event.sender.send('terminal-output', `\n[Process (PID ${pid}) and sub-processes terminated by user]\n`);
    } catch (e) {
      console.error('Error stopping process:', e);
    }
    activeChildProcess = null;
    return true;
  }
  return false;
});

// Runs an analyzed service. Commands originate from the local project analysis,
// and every stdout/stderr chunk is tagged so the UI can present each service separately.
ipcMain.handle('run-project-task', (event, { projectId, serviceId, action }) => {
  const project = store.get('projects', []).find((p) => p.id === projectId);
  const analysis = { ...(project?.aiAnalysis || {}), ...(project?.orchestration?.detection || {}), services: project?.orchestration?.detection?.services || project?.aiAnalysis?.services || [] };
  const service = analysis?.services?.find((item) => item.id === serviceId);
  if (!project || !service || !['install', 'start'].includes(action)) {
    return { success: false, error: 'The selected service is no longer available.' };
  }
  const command = action === 'install' ? service.installCommand : service.runCommand;
  if (!command) return { success: false, error: `No ${action} command was detected for this service.` };

  const processKey = `${projectId}:${serviceId}`;
  if (action === 'start' && projectProcesses.has(processKey)) {
    return { success: false, error: `${service.name} is already running.` };
  }

  const cwd = path.resolve(project.path, service.directory || '.');
  event.sender.send('project-task-output', { projectId, serviceId, data: `\n$ ${command}\n\n` });
  try {
    const child = spawn(command, { shell: true, cwd, env: { ...process.env, FORCE_COLOR: '1' } });
    if (action === 'start') projectProcesses.set(processKey, { process: child, projectId });
    const emit = (data) => event.sender.send('project-task-output', { projectId, serviceId, data: data.toString() });
    child.stdout.on('data', emit); child.stderr.on('data', emit);
    child.on('close', (code) => {
      event.sender.send('project-task-output', { projectId, serviceId, data: `\n[Process exited with code ${code}]\n` });
      projectProcesses.delete(processKey);
      event.sender.send('project-task-exit', { projectId, serviceId, code });
    });
    child.on('error', (error) => emit(`\n[Process error: ${error.message}]\n`));
    return { success: true, command };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('stop-project-service', (event, { projectId, serviceId }) => {
  const key = `${projectId}:${serviceId}`;
  const item = projectProcesses.get(key);
  if (!item) return false;
  try { item.process.kill(); } catch (e) {}
  projectProcesses.delete(key);
  return true;
});
