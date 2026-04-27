# 100 Extension Ideas — Consolidated Strategy Report

Research + 10 parallel domain agents × 10 ideas each = 100 scenarios, distilled into actionable insights.

## Platform Capabilities (Foundation)

| Capability | Description |
|---|---|
| CommandEmitter | Spawns a shell process, captures stdout line-by-line, routes lines through EventFilter |
| PromptEmitter | Re-runs an AI prompt on a timer, on session idle, or one-time |
| EventFilter | Regex pipeline: drop / keep / surface / inject — first match wins |
| SessionInjector | Proactively pushes events into the active conversation without you asking |
| Tool Registration | Expose any function as a Copilot tool call (AI can invoke it) |
| Slash Commands | Register /your-command handlers with full parameter parsing |
| Persistent Config | Read/write tap.config.json to save state between sessions |
| Child Processes | Spawn subprocesses (API calls, CLI tools, linters, scanners) as tool results |
| Hot-swap Filters | Change EventFilter rules while an emitter is running — no restart |
| Lifespan Control | Emitters can be temporary (session) or persistent (auto-restarts) |

### Core pattern

```
Background process → EventFilter → EventStream → SessionInjector → Your conversation
```

Everything builds on this: any background signal → filtered → injected as AI context. All 100 ideas follow this pattern.

---

## The 100 Ideas by Domain

### Domain 1 — DevOps & CI/CD

| # | Name | Pitch |
|---|---|---|
| 1 | PipelinePulse | Streams CI logs and injects AI-summarized failure root causes the moment a build breaks |
| 2 | DriftSentinel | Diffs live infra state against Terraform/Pulumi and alerts when configuration drifts |
| 3 | CanaryWhisperer | Watches canary metrics and auto-recommends promote/rollback with statistical confidence |
| 4 | SecretSweeper | Intercepts git push/docker build and scans staged diffs for leaked secrets pre-flight |
| 5 | BlastRadius | Before PR merge, maps every downstream service/pipeline affected and scores risk 0-10 |
| 6 | RollbackOracle | On deployment degradation, identifies the culprit commit and offers one-click rollback |
| 7 | CostGatekeeper | Injects estimated cloud cost deltas into every terraform plan, blocks over-budget applies |
| 8 | ChaosCompanion | Suggests and orchestrates chaos experiments based on live topology; auto-terminates on SLO breach |
| 9 | GitOpsDiff | Compares GitOps desired-state vs. actual cluster state and explains sync failures in plain English |
| 10 | DeployDiary | Auto-generates structured deployment journal entries per release, committed back to repo |

### Domain 2 — Security & Compliance

| # | Name | Pitch |
|---|---|---|
| 11 | SecretSentry | Wraps every shell command and redacts/blocks accidental secret leaks before they hit stdout |
| 12 | CVEWatch | Monitors your lockfiles against the GitHub Advisory API and injects CVE alerts on discovery |
| 13 | DriftDetect | Diffs live cloud IAM/security-group state against a compliance baseline in real time |
| 14 | AuditLens | Streams GitHub audit log events; lets you ask natural-language forensic questions |
| 15 | ThreatModel | Auto-generates a living STRIDE threat model from code changes and architecture files |
| 16 | LicenseCop | Scans transitive dependencies for license conflicts against your policy, blocks violations |
| 17 | ZeroTrustPosture | Evaluates repo zero-trust hygiene (OIDC, branch protections, signed commits) and scores it |
| 18 | SOC2Tracker | Maps engineering activities to SOC2 Trust Service Criteria and tracks evidence gaps |
| 19 | SASTSurface | Runs incremental SAST on changed files and injects HIGH/CRITICAL findings as you save |
| 20 | SBOMPulse | Generates/monitors your SBOM and alerts when component checksums change unexpectedly |

### Domain 3 — Developer Productivity & Code Quality

| # | Name | Pitch |
|---|---|---|
| 21 | FlowGuard | Detects context-switching frequency and nudges you back to your original task |
| 22 | DebtRadar | Surfaces tech debt hotspots in files you're actively editing, ranked by age and churn |
| 23 | CommitCoach | Scores staged commit messages and rewrites weak ones on demand via /commit |
| 24 | CoverageWatch | Alerts in real time when your edits drop test coverage below a configured threshold |
| 25 | BundleWatcher | Monitors JS bundle size on every build and flags regressions with the culprit import |
| 26 | RefactorPulse | Identifies long functions and high cyclomatic complexity in your current branch diff |
| 27 | DepFreshness | Warns when you import a dependency with a known CVE or major update, as you type |
| 28 | GhostCode | Detects dead exports and unused functions, offers to schedule a removal PR |
| 29 | LintDrift | Tracks linting error trends and flags when violations are trending upward |
| 30 | PRPulse | Injects live PR review comments into your editor session to eliminate the GitHub UI round-trip |

### Domain 4 — Team Collaboration & Communication

| # | Name | Pitch |
|---|---|---|
| 31 | StandupBot | Collects async standup updates from git/PR activity and synthesizes a team digest |
| 32 | PRNudge | Monitors stale PRs awaiting review and escalates with context injected into session |
| 33 | WarRoom | Spins up a structured incident channel with auto-assigned roles and live timeline |
| 34 | DepAlert | Detects when upstream teams merge breaking changes and notifies preemptively |
| 35 | OnboardPilot | Guides new engineers through codebase onboarding with contextual hints from git activity |
| 36 | VelocityWatch | Tracks sprint health in real time, surfaces blocked/scope-crept issues before retros |
| 37 | MergeMediator | When two PRs conflict, summarizes both and proposes a resolution strategy |
| 38 | KnowledgePulse | Captures implicit knowledge from PR review comments into a searchable knowledge base |
| 39 | OncallEscalate | Monitors on-call rotation and auto-escalates unacknowledged alerts with runbook links |
| 40 | AsyncBridge | Summarizes Slack/Teams threads relevant to your current branch and injects key decisions |

### Domain 5 — Data Engineering & Analytics

| # | Name | Pitch |
|---|---|---|
| 41 | PipelineWatch | Monitors dbt/Airflow DAG runs and injects failure context + upstream lineage |
| 42 | SchemaDrift | Alerts when upstream table schemas change in ways that will break your models |
| 43 | QuerySheriff | Flags query performance regressions as you write SQL, before they hit production |
| 44 | FreshnessCop | Monitors data freshness SLAs and alerts when tables go stale |
| 45 | SparkPulse | Streams Spark executor metrics (shuffle spills, GC pressure, skew) live into session |
| 46 | CostSentinel | Watches Snowflake/BigQuery billing and fires alerts when queries exceed cost budgets |
| 47 | DeadTableDetector | Finds tables unused for N days and proposes deprecation |
| 48 | CDCStreamHealth | Monitors Debezium/Kafka CDC lag, offset drift, and consumer group failures in real time |
| 49 | QualityGate | Runs Great Expectations/dbt tests and explains failures in plain English |
| 50 | AnomalyRadar | Detects statistical anomalies in key business metrics, surfaces them proactively |

### Domain 6 — Cloud Infrastructure & Kubernetes

| # | Name | Pitch |
|---|---|---|
| 51 | crashloop-cop | Auto-detects CrashLoopBackOff pods and injects root-cause summaries into session |
| 52 | quota-watch | Warns when namespace resource quotas near exhaustion before deployments fail |
| 53 | helm-drift | Detects when live cluster state has drifted from the Helm release manifest |
| 54 | terra-narrator | Pipes terraform plan output through Copilot and returns a plain-English risk summary |
| 55 | argo-pulse | Monitors ArgoCD sync status and injects degraded/failed application context automatically |
| 56 | node-scaler-log | Narrates Cluster Autoscaler decisions in real time, explaining why nodes are added/removed |
| 57 | cost-anomaly | Detects cloud spend spikes and correlates them with recent Kubernetes workload changes |
| 58 | netpol-audit | Audits NetworkPolicy coverage and flags pods with unrestricted ingress/egress |
| 59 | crd-deprecation-sentinel | Scans installed CRDs against the K8s version removal list before cluster upgrades |
| 60 | failover-coach | Guides cross-region failover runbook execution step-by-step with live state validation |

### Domain 7 — Testing & QA Automation

| # | Name | Pitch |
|---|---|---|
| 61 | FlakeHunter | Detects flaky tests by watching CI run history for non-deterministic failures |
| 62 | CoverageGuard | Blocks coverage regressions in real time by watching lcov/istanbul diffs on save |
| 63 | MutantWhisperer | Runs mutation testing on changed files and injects surviving mutants as test-writing prompts |
| 64 | SplitAdvisor | Analyzes test suite timing and recommends optimal CI matrix parallelization splits |
| 65 | PixelSentry | Watches visual regression reports (Percy/Playwright) and injects diff summaries |
| 66 | BlastRadius (Test) | Maps which E2E tests historically fail when a given file changes |
| 67 | LoadLens | Streams k6/Locust load test metrics and injects threshold breach alerts live |
| 68 | SeedVault | Manages test fixtures by generating and versioning realistic seed data on demand |
| 69 | PropBot | Suggests property-based test cases by analyzing function signatures and boundary gaps |
| 70 | SnapDrift | Monitors snapshot test churn and flags blind jest -u updates that mask regressions |

### Domain 8 — Documentation & Knowledge Management

| # | Name | Pitch |
|---|---|---|
| 71 | ADRscribe | Watches commits and drafts Architecture Decision Records when structural changes are detected |
| 72 | StaleDoc | Monitors source changes and flags documentation that hasn't been updated in sync |
| 73 | Postmortem Pilot | Assembles structured postmortem drafts from incident logs, alert history, and git blame |
| 74 | ChangelogCraft | Generates human-readable changelogs from PR titles, labels, and linked issues since last tag |
| 75 | GlossaryGrow | Watches code/docs for undefined jargon and incrementally evolves a team glossary |
| 76 | RunbookBot | Auto-generates runbooks by observing commands engineers actually run during incidents |
| 77 | READMEscore | Scores README health across all org repos and surfaces the worst offenders |
| 78 | DiagramDrift | Detects when Mermaid/PlantUML architecture diagrams diverge from actual codebase structure |
| 79 | OnboardOracle | Builds personalized onboarding knowledge paths based on what files a new engineer has touched |
| 80 | CommentCoverage | Tracks code comment coverage and enforces doc standards on public APIs |

### Domain 9 — AI/ML & Data Science Workflows

| # | Name | Pitch |
|---|---|---|
| 81 | TrainWatch | Monitors training runs and injects loss/metric anomalies into session live |
| 82 | DriftSentry (ML) | Watches production inference logs for input feature distribution drift from training baselines |
| 83 | HyperPilot | Injects past MLflow/W&B experiment results to turn Copilot into a Bayesian HP advisor |
| 84 | GPUWatch | Streams GPU utilization, VRAM, and thermal throttle events with remediation hints |
| 85 | EvalGate | Runs evaluation harness after every code change and injects metric deltas before commit |
| 86 | DataFresh | Monitors feature store staleness and warns when you reference outdated datasets |
| 87 | PromptAB | Runs A/B evaluations of prompt variants against a judge LLM and streams ranked results |
| 88 | FineTuneWatch | Tails fine-tuning job logs (OpenAI/Vertex/SageMaker) and surfaces completion + cost |
| 89 | ModelCardGen | Auto-generates HuggingFace-compatible model cards from eval results and training config |
| 90 | ExperimentNarrator | Injects a natural-language narrative of recent experiments so you can ask "what have I tried?" |

### Domain 10 — Enterprise Governance & Org Management

| # | Name | Pitch |
|---|---|---|
| 91 | PolicyGuard | Enforces org-wide policy-as-code rules (via OPA) before every commit or PR |
| 92 | RepoScore | Gives every repo a live health score across security, docs, coverage, and dependency freshness |
| 93 | OwnerDrift | Detects when CODEOWNERS entries no longer match actual committers and suggests corrections |
| 94 | LicenseWarden | Audits all transitive dependencies for license compatibility against org-approved list |
| 95 | BranchShield | Audits branch protection rules org-wide and alerts/auto-remediates regressions |
| 96 | InnerSource Pulse | Tracks cross-team contributions to shared libraries and surfaces engagement trends |
| 97 | APIDeprecator | Tracks deprecated internal APIs and alerts consuming teams before sunset dates |
| 98 | CostCenter | Attributes cloud spend and Actions minutes to teams using repo metadata and CODEOWNERS |
| 99 | FitnessFn | Runs architectural fitness functions as executable guardrails, blocking layering violations |
| 100 | SLAWatch | Monitors open incidents and PRs against SLA commitments and injects breach alerts live |

---

## Top 20 Recommendations

Ranked by impact × buildability × novelty.

### Tier 1 — Build First (High Impact, Directly Buildable)

| Rank | Extension | Why It Wins |
|---|---|---|
| 1 | PipelinePulse | Solves the #1 developer pain: watching CI. Pure CommandEmitter + EventFilter. Near-zero infra. |
| 2 | DriftSentinel | IaC drift is universal. Periodic terraform plan + filter is the exact tap pattern. |
| 3 | PRPulse | Eliminates the editor-GitHub UI round-trip. Uses gh pr view CommandEmitter. |
| 4 | SASTSurface | SAST in seconds not CI minutes. Uses semgrep --json + EventFilter. |
| 5 | FlakeHunter | Flaky tests erode team trust. CI log tailing is exactly what tap does best. |

### Tier 2 — High Leverage, Moderate Complexity

| Rank | Extension | Why It Wins |
|---|---|---|
| 6 | CanaryWhisperer | Prometheus/Datadog polling + promote/rollback slash commands. |
| 7 | SecretSentry | Intercepts every shell command; pre-git-push defense. High security ROI. |
| 8 | CVEWatch | GitHub Advisory API polling + lockfile scanning. Nearly every team needs this. |
| 9 | BlastRadius | Pre-merge risk scoring changes merge culture. Reads CODEOWNERS + GitHub API. |
| 10 | CoverageWatch | Test coverage regression is invisible until CI fails. Live feedback closes the loop. |

### Tier 3 — Strategic & Differentiated

| Rank | Extension | Why It Wins |
|---|---|---|
| 11 | ExperimentNarrator | Unique to ML teams; session-start context injection from MLflow/W&B. |
| 12 | ADRscribe | ADRs never get written. Triggering on commit patterns is elegant. |
| 13 | DeployDiary | Compliance artifact generated automatically. Huge for regulated industries. |
| 14 | FitnessFn | Architectural fitness functions as CI is proven; via Copilot it becomes conversational. |
| 15 | ThreatModel | Living threat models that stay in sync with code are a massive security gap. |
| 16 | StandupBot | Async standup from git activity eliminates synchronous ceremonies. |
| 17 | ChangelogCraft | Release changelogs are universally hated to write. Fully automatable. |
| 18 | GPUWatch | nvidia-smi dmon as a CommandEmitter is trivial; diagnostic value is enormous. |
| 19 | CostGatekeeper | Infracost integration as a filter on terraform apply is a clear budget win. |
| 20 | RepoScore | Org-wide health scoring via GitHub API is a platform engineering multiplier. |

---

## The 5 Core Extension Archetypes

```
1. WATCHER    — CommandEmitter + EventFilter + SessionInjector
               (PipelinePulse, CVEWatch, GPUWatch, FlakeHunter)
               Pattern: tail a process → filter → inject

2. SCHEDULER  — PromptEmitter on timer/idle + SessionInjector
               (DriftSentinel, StandupBot, AnomalyRadar, HyperPilot)
               Pattern: poll on schedule → AI synthesizes → inject

3. GATEKEEPER — Tool wraps a command, blocks/modifies output
               (SecretSentry, CostGatekeeper, LicenseCop, PolicyGuard)
               Pattern: intercept action → check → allow/block/annotate

4. ADVISOR    — Slash command + multi-tool AI analysis
               (BlastRadius, CanaryWhisperer, ThreatModel, terra-narrator)
               Pattern: /command → gather data → AI reasons → report

5. RECORDER   — Slash command + writes artifacts back to repo
               (DeployDiary, ADRscribe, ChangelogCraft, ModelCardGen)
               Pattern: /command → gather context → AI writes → git commit
```

| Archetype | SDK Features Used | Complexity |
|---|---|---|
| Watcher | CommandEmitter, EventFilter, SessionInjector | Low |
| Scheduler | PromptEmitter (interval/idle), SessionInjector | Low |
| Gatekeeper | Tool registration, child_process, inject | Medium |
| Advisor | Slash command, multiple tools, external APIs | Medium |
| Recorder | Slash command, tools, fs.writeFile, git | Higher |

---

## Recommended Build Roadmap

### Phase 1 — Extend ※ tap (Immediate)

- **PipelinePulse** — gh run watch CommandEmitter with AI failure diagnosis
- **PRPulse** — gh pr view --comments + new-comment EventFilter
- **CoverageWatch** — Jest/Vitest coverage CommandEmitter with threshold config

### Phase 2 — New Extensions (using tap as template)

- **DriftSentinel** — terraform plan -json PromptEmitter for IaC drift
- **SASTSurface** — semgrep --json on git diff with HIGH/CRITICAL filter
- **CVEWatch** — GitHub Advisory API PromptEmitter on idle

### Phase 3 — Advanced Extensions (Strategic)

- **CanaryWhisperer** — Prometheus/Datadog polling + promote/rollback slash commands
- **ADRscribe** — Commit-triggered ADR drafting with git-pattern detection
- **ExperimentNarrator** — MLflow/W&B session-start context injection
- **DeployDiary** — Multi-source deployment record generation and git commit

---

## Key Insight

> The terminal is ambient. Copilot is conversational. The gap between them — background signals that require your attention — is exactly where extensions live.

> Every great extension answers one question: "What would you want to already know when you start your next conversation?"

The tap pattern — **watch → filter → inject** — is the universal primitive. All 100 ideas are variations of filling that gap in specific domains. The best ones work silently until something needs your attention, then interrupt precisely and contextually.
