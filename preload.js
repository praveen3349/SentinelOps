const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  selectDirectory: () => ipcRenderer.invoke('select-directory'),

  getCredentials: (provider) => ipcRenderer.invoke('get-credentials', provider),
  saveCredentials: (provider, credentials) => ipcRenderer.invoke('save-credentials', { provider, credentials }),

  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  saveApiConfig: (config) => ipcRenderer.invoke('save-api-config', config),

  cloneRepo: (payload) => ipcRenderer.invoke('clone-repo', payload),
  cloneRepoWithAuth: (payload) => ipcRenderer.invoke('clone-repo-with-auth', payload),

  onCloneProgress: (callback) => {
    ipcRenderer.removeAllListeners('clone-progress');
    ipcRenderer.on('clone-progress', (event, msg) => callback(msg));
  },

  getProjects: () => ipcRenderer.invoke('get-projects'),
  removeProject: (id) => ipcRenderer.invoke('remove-project', id),
  deleteClonedProject: (id) => ipcRenderer.invoke('delete-cloned-project', id),
  updateProjectConfig: (id, config) => ipcRenderer.invoke('update-project-config', { id, config }),

  getDockerStatus: () => ipcRenderer.invoke('get-docker-status'),
  prepareDockerProject: (projectId) => ipcRenderer.invoke('prepare-docker-project', projectId),
  runDockerTask: (payload) => ipcRenderer.invoke('run-docker-task', payload),
  confirmLocalValidation: (projectId) => ipcRenderer.invoke('confirm-local-validation', projectId),
  generatePipelineAssets: (payload) => ipcRenderer.invoke('generate-pipeline-assets', payload),
  getDeploymentRecommendation: (projectId) => ipcRenderer.invoke('get-deployment-recommendation', projectId),
  generateDeploymentAssets: (payload) => ipcRenderer.invoke('generate-deployment-assets', payload),
  probeProjectHealth: (projectId) => ipcRenderer.invoke('probe-project-health', projectId),
  onDockerTaskOutput: (callback) => {
    ipcRenderer.removeAllListeners('docker-task-output');
    ipcRenderer.on('docker-task-output', (event, payload) => callback(payload));
  },
  onDockerTaskExit: (callback) => {
    ipcRenderer.removeAllListeners('docker-task-exit');
    ipcRenderer.on('docker-task-exit', (event, payload) => callback(payload));
  },

  getFileTree: (projectPath) => ipcRenderer.invoke('get-file-tree', projectPath),
  readFileContent: (filePath) => ipcRenderer.invoke('read-file-content', filePath),

  aiAnalyzeProject: (projectId) => ipcRenderer.invoke('ai-analyze-project', projectId),
  aiSolveError: (payload) => ipcRenderer.invoke('ai-solve-error', payload),

  runTerminalCommand: (payload) => ipcRenderer.invoke('run-terminal-command', payload),
  stopTerminalCommand: () => ipcRenderer.invoke('stop-terminal-command'),

  runProjectTask: (payload) => ipcRenderer.invoke('run-project-task', payload),
  stopProjectService: (payload) => ipcRenderer.invoke('stop-project-service', payload),
  onProjectTaskOutput: (callback) => {
    ipcRenderer.removeAllListeners('project-task-output');
    ipcRenderer.on('project-task-output', (event, payload) => callback(payload));
  },
  onProjectTaskExit: (callback) => {
    ipcRenderer.removeAllListeners('project-task-exit');
    ipcRenderer.on('project-task-exit', (event, payload) => callback(payload));
  },

  onTerminalOutput: (callback) => {
    ipcRenderer.removeAllListeners('terminal-output');
    ipcRenderer.on('terminal-output', (event, data) => callback(data));
  },

  onTerminalExit: (callback) => {
    ipcRenderer.removeAllListeners('terminal-exit');
    ipcRenderer.on('terminal-exit', (event, code) => callback(code));
  }
});
