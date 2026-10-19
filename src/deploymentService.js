const fs = require('fs');
const path = require('path');

function name(value) {
  return String(value || 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

function inside(root, candidate) {
  const base = path.resolve(root);
  const target = path.resolve(base, candidate);
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('Unsafe deployment asset path.');
  return target;
}

function recommendation(services) {
  const webServices = services.filter((service) => service.port);
  if (!webServices.length) return { profile: 'native', reason: 'No public HTTP service was detected; native execution is the least complex option.' };
  if (services.length >= 3) return { profile: 'kubernetes', reason: 'Several services were detected; Kubernetes provides service isolation, rolling updates, and horizontal autoscaling.' };
  return { profile: 'container', reason: 'A small web workload was detected; Docker Compose is the recommended balance of portability and operational simplicity.' };
}

function workloadYaml(project, service, scale) {
  const appName = `${name(project.name)}-${name(service.id || service.name)}`;
  const image = `${name(project.name)}-${name(service.id || service.name)}:local`;
  const port = Number(service.port) || 8080;
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${appName}
  labels:
    app.kubernetes.io/name: ${appName}
spec:
  replicas: ${scale.minReplicas}
  selector:
    matchLabels:
      app.kubernetes.io/name: ${appName}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ${appName}
    spec:
      containers:
        - name: application
          image: ${image}
          imagePullPolicy: IfNotPresent
          ports:
            - containerPort: ${port}
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 512Mi
          readinessProbe:
            tcpSocket:
              port: ${port}
            initialDelaySeconds: 5
            periodSeconds: 10
          livenessProbe:
            tcpSocket:
              port: ${port}
            initialDelaySeconds: 15
            periodSeconds: 20
---
apiVersion: v1
kind: Service
metadata:
  name: ${appName}
spec:
  selector:
    app.kubernetes.io/name: ${appName}
  ports:
    - port: ${port}
      targetPort: ${port}
  type: ClusterIP
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ${appName}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: ${appName}
  minReplicas: ${scale.minReplicas}
  maxReplicas: ${scale.maxReplicas}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: ${scale.targetCpu}
`;
}

function maintenanceRunbook(project, services, scale) {
  return `# SentinelOps maintenance runbook — ${project.name}

## Health signals
- HTTP readiness and liveness checks are generated for every detected web service.
- Prometheus should scrape application metrics at /metrics when supported.
- Grafana should alert on sustained error rate, latency, and unavailable targets.

## Autoscaling policy
- Minimum replicas: ${scale.minReplicas}
- Maximum replicas: ${scale.maxReplicas}
- Scale-out threshold: average CPU above ${scale.targetCpu}%
- Scale-in occurs only after the platform's stabilization window.

## Failure handling
1. Confirm the failing service, version, and latest deployment event.
2. Check application logs and the local SentinelOps health probe.
3. Roll back to the prior image if readiness cannot recover.
4. Create a ticket/notification through the selected integration.

## Detected services
${services.map((service) => `- ${service.name}: ${service.framework || service.type}${service.port ? ` on port ${service.port}` : ''}`).join('\n')}
`;
}

function generateDeploymentAssets(project, services, input = {}) {
  const scale = {
    minReplicas: Math.max(1, Number(input.minReplicas) || 2),
    maxReplicas: Math.max(2, Number(input.maxReplicas) || 8),
    targetCpu: Math.min(95, Math.max(20, Number(input.targetCpu) || 70))
  };
  if (scale.maxReplicas < scale.minReplicas) scale.maxReplicas = scale.minReplicas;
  const root = inside(project.path, '.sentinelops/deployment');
  fs.mkdirSync(root, { recursive: true });
  const assets = [];
  const recommendationResult = recommendation(services);
  if (input.profile === 'kubernetes') {
    for (const service of services.filter((item) => item.port)) {
      const file = inside(project.path, path.join('.sentinelops/deployment', `${name(service.id)}.k8s.yaml`));
      fs.writeFileSync(file, workloadYaml(project, service, scale), 'utf8');
      assets.push({ type: 'Kubernetes Deployment, Service & HPA', path: file, service: service.name });
    }
  }
  const runbookPath = inside(project.path, '.sentinelops/deployment/MAINTENANCE.md');
  fs.writeFileSync(runbookPath, maintenanceRunbook(project, services, scale), 'utf8');
  assets.push({ type: 'Maintenance runbook', path: runbookPath });
  return { recommendation: recommendationResult, scale, assets, directory: root };
}

module.exports = { recommendation, generateDeploymentAssets };
