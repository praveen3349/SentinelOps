# SentinelOps

SentinelOps is an Electron desktop control plane for taking a Git repository from analysis to a reviewable local, container, CI/CD, deployment, and observability plan.

## Implemented workflow

1. Clone a GitHub, GitLab, or generic Git repository into a user-selected local directory.
2. Inspect repository files to detect Node.js, React, Next.js, Vue, Angular, Python, Flask, FastAPI, Django, Go, Rust, and common frontend/backend layouts.
3. Present each detected service with an install command, start command, entry point, and expected local URL. Detection can be corrected manually.
4. Install requirements and run services locally with streamed output.
5. Confirm a successful local test to unlock delivery asset generation.
6. Choose a deployment profile: native server, Docker Compose, or Kubernetes. SentinelOps recommends one from the workload shape.
7. Generate isolated Dockerfiles, a Docker Compose file, CI/CD files for GitHub Actions, Jenkins, or GitLab CI, Prometheus configuration, a Grafana dashboard, Kubernetes manifests/HPA where applicable, and a maintenance runbook.
8. Check Docker availability, pull base images, build images, and run containers when the user already has Docker available.
9. Run local HTTP health probes for detected services and display a self-healing/maintenance policy.

Generated files stay under `.sentinelops/` in the cloned repository. Existing application source files are not overwritten.

## Important safety boundaries

- SentinelOps does **not** install Docker Desktop. On Windows, install and start Docker Desktop yourself before using container actions.
- The app does not connect to a cloud account or Kubernetes cluster yet. It generates reviewable deployment assets; applying them requires explicitly configured infrastructure and credentials.
- Autoscaling manifests require Kubernetes Metrics Server. The generated HPA scales on CPU utilization between the configured minimum and maximum replicas.
- Grafana and Prometheus generation produces configuration and a local Compose plan. It does not create or configure a remote hosted Grafana/Prometheus account.
- The native error solver recommends fixes. It does not silently modify source code or deploy changes.

## Requirements

- Node.js 18 or newer
- Git available on the system PATH
- Docker Desktop/Engine only when using Docker pull/build/run actions

## Run locally

```bash
npm install
npm start
```

## Generated asset layout

```text
<cloned-project>/
├── .sentinelops/
│   ├── Dockerfile                     # one per detected service directory
│   ├── deployment/
│   │   ├── <service>.k8s.yaml         # Deployment + Service + HPA (Kubernetes profile)
│   │   └── MAINTENANCE.md
│   └── generated/
│       ├── Jenkinsfile | github-actions.yml | gitlab-ci.yml
│       ├── prometheus.yml
│       ├── grafana-dashboard.json
│       └── observability-compose.yml
└── .sentinelops-compose.yml
```

## Project structure

```text
src/
├── aiAnalyzer.js        # stack detection and local run strategy
├── dockerService.js     # Docker status, Dockerfile, Compose generation
├── deploymentService.js # deployment recommendation, Kubernetes HPA and runbook generation
├── pipelineService.js   # CI/CD and observability asset generation
└── gitService.js        # clone and branch metadata
```
