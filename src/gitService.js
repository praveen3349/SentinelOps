const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');

function buildAuthUrl(repoUrl, provider, credentials) {
  if (!credentials) return repoUrl;

  try {
    const u = new URL(repoUrl);

    if (provider === 'github' && credentials.token) {
      u.username = credentials.token;
      u.password = '';
    } else if (provider === 'bitbucket' && credentials.appPassword) {
      u.username = credentials.username || 'x-token-auth';
      u.password = credentials.appPassword;
    }

    return u.toString();
  } catch (e) {
    return repoUrl;
  }
}

function normalizeRepoUrl(repoUrl) {
  let url = repoUrl.trim();
  if (url.startsWith('git@github.com:')) {
    url = 'https://github.com/' + url.replace('git@github.com:', '');
  }
  if (url.startsWith('git@bitbucket.org:')) {
    url = 'https://bitbucket.org/' + url.replace('git@bitbucket.org:', '');
  }
  if (url.endsWith('.git')) {
    url = url.slice(0, -4);
  }
  return url.replace(/\/$/, '');
}

function repoNameFromUrl(repoUrl) {
  const clean = normalizeRepoUrl(repoUrl);
  const parts = clean.split('/');
  return parts[parts.length - 1] || 'project';
}

/**
 * Gets branch info using simple-git if available, otherwise returns fallback
 */
async function getGitBranches(targetPath) {
  try {
    const git = simpleGit(targetPath);
    const branchSummary = await git.branch();
    return {
      currentBranch: branchSummary.current || 'main',
      branches: branchSummary.all || ['main'],
      detached: branchSummary.detached
    };
  } catch (e) {
    return {
      currentBranch: 'main',
      branches: ['main'],
      error: 'Git CLI not available'
    };
  }
}

/**
 * Downloads a URL following redirects to a file
 */
function downloadFile(url, destPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'User-Agent': 'SentinelOps-DevOps-Client',
        ...headers
      }
    };

    const client = url.startsWith('https') ? https : http;
    client.get(url, options, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        return downloadFile(response.headers.location, destPath, headers).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
      }

      const fileStream = fs.createWriteStream(destPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close(() => resolve(destPath));
      });

      fileStream.on('error', (err) => {
        fs.unlink(destPath, () => reject(err));
      });
    }).on('error', reject);
  });
}

/**
 * Fallback ZIP Downloader when git CLI is not installed on system (spawn ENOENT)
 */
async function downloadAndExtractZip({ repoUrl, targetPath, credentials, onProgress }) {
  const cleanUrl = normalizeRepoUrl(repoUrl);
  const repoName = repoNameFromUrl(cleanUrl);
  const tempZip = path.join(path.dirname(targetPath), `_temp_${repoName}_${Date.now()}.zip`);
  const tempExtract = path.join(path.dirname(targetPath), `_temp_extract_${repoName}_${Date.now()}`);

  const possibleZipUrls = [
    `${cleanUrl}/archive/refs/heads/main.zip`,
    `${cleanUrl}/archive/refs/heads/master.zip`,
    `${cleanUrl}/get/main.zip`,
    `${cleanUrl}/get/master.zip`
  ];

  let downloaded = false;
  let headers = {};

  if (credentials && credentials.token) {
    headers['Authorization'] = `token ${credentials.token}`;
  }

  for (const zipUrl of possibleZipUrls) {
    try {
      if (onProgress) onProgress(`Downloading repository ZIP archive (${path.basename(zipUrl)})...`);
      await downloadFile(zipUrl, tempZip, headers);
      downloaded = true;
      break;
    } catch (e) {
      // Try next candidate URL
    }
  }

  if (!downloaded) {
    throw new Error(`Failed to download repository zip archive. Please verify repository URL and access permissions.`);
  }

  try {
    if (onProgress) onProgress('Extracting repository archive...');
    fs.mkdirSync(tempExtract, { recursive: true });

    // Use PowerShell Expand-Archive on Windows
    await new Promise((resolve, reject) => {
      const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${tempZip}' -DestinationPath '${tempExtract}' -Force"`;
      exec(psCmd, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // GitHub/Bitbucket zips extract into a single subfolder (e.g. hotelhub-main)
    const items = fs.readdirSync(tempExtract);
    let sourceFolder = tempExtract;
    if (items.length === 1 && fs.statSync(path.join(tempExtract, items[0])).isDirectory()) {
      sourceFolder = path.join(tempExtract, items[0]);
    }

    // Move sourceFolder contents to targetPath
    fs.mkdirSync(targetPath, { recursive: true });
    const filesToMove = fs.readdirSync(sourceFolder);
    for (const f of filesToMove) {
      fs.renameSync(path.join(sourceFolder, f), path.join(targetPath, f));
    }

    if (onProgress) onProgress('Extraction complete!');
    return { success: true, targetPath };
  } finally {
    // Cleanup temporary files
    try { if (fs.existsSync(tempZip)) fs.unlinkSync(tempZip); } catch (e) {}
    try { if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true }); } catch (e) {}
  }
}

/**
 * Clones a repo into destParentPath/<repoName>.
 */
async function cloneRepository({ repoUrl, provider, destParentPath, credentials, onProgress }) {
  const cleanUrl = normalizeRepoUrl(repoUrl);
  const repoName = repoNameFromUrl(cleanUrl);
  const targetPath = path.join(destParentPath, repoName);

  if (fs.existsSync(targetPath)) {
    return {
      success: false,
      error: `Folder "${repoName}" already exists at destination. Choose a different destination or remove the existing folder.`
    };
  }

  const cloneUrl = `${cleanUrl}.git`;
  const authUrl = buildAuthUrl(cloneUrl, provider, credentials);

  const git = simpleGit({
    progress: ({ stage, progress }) => {
      if (onProgress) onProgress(`${stage} ${progress ? progress + '%' : ''}`.trim());
    }
  });

  try {
    if (onProgress) onProgress(`Cloning ${cloneUrl} ...`);
    await git.clone(authUrl, targetPath);
    if (onProgress) onProgress('Clone complete.');
    return { success: true, targetPath };
  } catch (err) {
    const message = (err && err.message) || String(err);

    // Clean up partial clone folder if created
    try {
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: true, force: true });
      }
    } catch (cleanupErr) { /* ignore */ }

    // If git executable is missing (ENOENT) or git fails, fall back to HTTP ZIP download
    if (message.includes('ENOENT') || message.includes('spawn git') || message.includes('git')) {
      try {
        if (onProgress) onProgress('Git CLI not found. Falling back to SentinelOps HTTP Zip Downloader...');
        return await downloadAndExtractZip({ repoUrl: cleanUrl, targetPath, credentials, onProgress });
      } catch (zipErr) {
        return { success: false, error: `Git clone and HTTP zip download failed: ${zipErr.message}` };
      }
    }

    const authFailurePatterns = [
      'Authentication failed',
      'could not read Username',
      'terminal prompts disabled',
      '403',
      'Repository not found',
      'fatal: could not read Password'
    ];
    const needsAuth = authFailurePatterns.some((p) => message.includes(p));

    return { success: false, error: message, needsAuth };
  }
}

module.exports = { cloneRepository, getGitBranches, normalizeRepoUrl, repoNameFromUrl };
