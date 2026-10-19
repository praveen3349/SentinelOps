const fs = require('fs');
const path = require('path');

function safePath(projectPath, filePath) {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, filePath);
  if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error('Unsafe generated asset path.');
  return resolved;
}

function dockerComposeCommand(project) {
  return `docker compose -f .sentinelops-compose.yml`;
}

function pipelineContent(provider, project) {
  const compose = dockerComposeCommand(project);
  if (provider === 'jenkins') return `pipeline {
  agent any
  stages {
    stage('Checkout') { steps { checkout scm } }
    stage('Local validation') { steps { echo 'Validated in SentinelOps before delivery' } }
    stage('Build images') { steps { sh '${compose} build' } }
    stage('Deploy') { steps { sh '${compose} up -d' } }
  }
  post { always { sh '${compose} ps || true' } }
}
`;
  if (provider === 'gitlab') return `stages: [validate, build, deploy]

validate:
  stage: validate
  script: ["echo 'Validated in SentinelOps before delivery'"]

build:
  stage: build
  script: ["${compose} build"]

deploy:
  stage: deploy
  script: ["${compose} up -d"]
`;
  return `name: SentinelOps delivery
on: [push, workflow_dispatch]
jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Validate local plan
        run: echo "Validated in SentinelOps before delivery"
      - name: Build images
        run: ${compose} build
      - name: Deploy
        run: ${compose} up -d
`;
}

function prometheusContent(services) {
  const targets = services.filter((service) => service.port).map((service) => `'${service.id}:${service.port}'`).join(', ');
  return `global:
  scrape_interval: 15s
scrape_configs:
  - job_name: sentinelops-apps
    static_configs:
      - targets: [${targets}]
`;
}

function grafanaDashboard(project, services) {
  return JSON.stringify({
    title: `SentinelOps: ${project.name}`,
    timezone: 'browser',
    schemaVersion: 39,
    panels: services.map((service, index) => ({ id: index + 1, type: 'timeseries', title: `${service.name} health`, targets: [{ expr: `up{job="${service.id}"}` }] }))
  }, null, 2);
}

function observabilityCompose(project) {
  const projectName = String(project.name || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-');
  return `# Start after the application compose stack is running.
services:
  prometheus:
    image: prom/prometheus:v2.54.1
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
  grafana:
    image: grafana/grafana:11.1.4
    ports:
      - "3002:3000"
    environment:
      GF_SECURITY_ADMIN_USER: sentinelops
      GF_SECURITY_ADMIN_PASSWORD: change-me-before-production
    volumes:
      - grafana-data:/var/lib/grafana
volumes:
  grafana-data:
# Project: ${projectName}
`;
}

function generatePipelineAssets(project, services, { provider = 'github', observability = true } = {}) {
  const generatedDir = safePath(project.path, '.sentinelops/generated');
  fs.mkdirSync(generatedDir, { recursive: true });
  const pipelineFile = provider === 'jenkins' ? 'Jenkinsfile' : provider === 'gitlab' ? 'gitlab-ci.yml' : 'github-actions.yml';
  const pipelinePath = path.join(generatedDir, pipelineFile);
  fs.writeFileSync(pipelinePath, pipelineContent(provider, project), 'utf8');
  const assets = [{ type: `${provider} pipeline`, path: pipelinePath }];
  if (observability) {
    const promPath = path.join(generatedDir, 'prometheus.yml');
    const grafanaPath = path.join(generatedDir, 'grafana-dashboard.json');
    fs.writeFileSync(promPath, prometheusContent(services), 'utf8');
    fs.writeFileSync(grafanaPath, grafanaDashboard(project, services), 'utf8');
    const composePath = path.join(generatedDir, 'observability-compose.yml');
    fs.writeFileSync(composePath, observabilityCompose(project), 'utf8');
    assets.push({ type: 'Prometheus configuration', path: promPath }, { type: 'Grafana dashboard', path: grafanaPath }, { type: 'Prometheus and Grafana Compose stack', path: composePath });
  }
  return { generatedDir, assets };
}

module.exports = { generatePipelineAssets };
