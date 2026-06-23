# Graph Report - .  (2026-06-23)

## Corpus Check
- Corpus is ~24,331 words - fits in a single context window. You may not need a graph.

## Summary
- 358 nodes · 607 edges · 22 communities (17 shown, 5 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 16 edges (avg confidence: 0.86)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Google Messages Automation|Google Messages Automation]]
- [[_COMMUNITY_Docs & Project Concepts|Docs & Project Concepts]]
- [[_COMMUNITY_Dashboard Frontend|Dashboard Frontend]]
- [[_COMMUNITY_API Server Core|API Server Core]]
- [[_COMMUNITY_Package & Dependencies|Package & Dependencies]]
- [[_COMMUNITY_Config & Dev Scripts|Config & Dev Scripts]]
- [[_COMMUNITY_Admin Menu Script|Admin Menu Script]]
- [[_COMMUNITY_API Key Store|API Key Store]]
- [[_COMMUNITY_Send Queue (BullMQ)|Send Queue (BullMQ)]]
- [[_COMMUNITY_Public Dashboard Setup|Public Dashboard Setup]]
- [[_COMMUNITY_Request Auth & Rate Limiting|Request Auth & Rate Limiting]]
- [[_COMMUNITY_Dashboard Sessions|Dashboard Sessions]]
- [[_COMMUNITY_Uninstall Script|Uninstall Script]]
- [[_COMMUNITY_OpenAPI Export|OpenAPI Export]]
- [[_COMMUNITY_OpenAPI Generate|OpenAPI Generate]]
- [[_COMMUNITY_Messages Client Module|Messages Client Module]]
- [[_COMMUNITY_Ubuntu Installer|Ubuntu Installer]]
- [[_COMMUNITY_VNC Pairing Script|VNC Pairing Script]]
- [[_COMMUNITY_VPS Chrome Script|VPS Chrome Script]]
- [[_COMMUNITY_Server Bootstrap|Server Bootstrap]]
- [[_COMMUNITY_Systemd Service Control|Systemd Service Control]]
- [[_COMMUNITY_Password Verification|Password Verification]]

## God Nodes (most connected - your core abstractions)
1. `GoogleMessagesClient` - 54 edges
2. `$()` - 41 edges
3. `menu_loop()` - 18 edges
4. `ApiKeyStore` - 18 edges
5. `gmweb-menu.sh script` - 16 edges
6. `need_root()` - 13 edges
7. `api()` - 12 edges
8. `scripts` - 11 edges
9. `SendQueue` - 10 edges
10. `requireToken()` - 10 edges

## Surprising Connections (you probably didn't know these)
- `Dashboard embedded VNC console` --semantically_similar_to--> `VNC/noVNC pairing flow`  [INFERRED] [semantically similar]
  public/dashboard/index.html → docs/SIMPLE_SETUP.md
- `GMweb API HTTP bridge` --conceptually_related_to--> `GMweb`  [INFERRED]
  README.md → CLAUDE.md
- `GMweb Dashboard UI` --references--> `GET /conversations endpoint`  [INFERRED]
  public/dashboard/index.html → docs/API.md
- `POST /send endpoint` --shares_data_with--> `BullMQ send queue (queue.js)`  [INFERRED]
  docs/API.md → CLAUDE.md
- `GMweb API endpoints reference` --references--> `Auth model (master token vs project key)`  [INFERRED]
  docs/API.md → CLAUDE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **OpenAPI contract sync flow** — claude_openapi_generation, docs_integration_openapi_json, docs_api_health, docs_integration_docs_json, docs_integration_consumer [EXTRACTED 1.00]
- **Headless VPS pairing stack** — docs_vps_no_gui_xvfb, docs_simple_setup_vnc_pairing, docs_vps_no_gui_connect_mode, docs_operations_browser_profile [INFERRED 0.85]
- **Message send pipeline** — docs_api_send, claude_queue_js, claude_redis, claude_google_messages_client [INFERRED 0.85]

## Communities (22 total, 5 thin omitted)

### Community 1 - "Docs & Project Concepts"
Cohesion: 0.07
Nodes (46): Project API keys (apiKeys.js), Auth model (master token vs project key), Chromium / Playwright browser, Env config (config.js), API contract sync policy, GMweb, googleMessagesClient.js Playwright automation, Master token (API_TOKEN) (+38 more)

### Community 2 - "Dashboard Frontend"
Cohesion: 0.10
Nodes (36): $(), api(), buildApiKeyRow(), buildMessageDivs(), cleanText(), compactState(), connectSSE(), conversationMessage() (+28 more)

### Community 3 - "API Server Core"
Cohesion: 0.06
Nodes (26): ADMIN_ONLY_PREFIXES, { ApiKeyStore }, app, authFailBuckets, client, config, contentTypes, cors (+18 more)

### Community 4 - "Package & Dependencies"
Cohesion: 0.07
Nodes (26): dependencies, bullmq, dotenv, fastify, @fastify/cors, @fastify/http-proxy, @fastify/swagger, @fastify/swagger-ui (+18 more)

### Community 5 - "Config & Dev Scripts"
Cohesion: 0.09
Nodes (17): check(), config, fs, main(), pkg, config, main(), request() (+9 more)

### Community 6 - "Admin Menu Script"
Cohesion: 0.27
Nodes (21): gmweb-menu.sh script, logs(), menu_loop(), need_root(), pause(), public_dashboard(), ready_check(), render_menu() (+13 more)

### Community 7 - "API Key Store"
Cohesion: 0.16
Nodes (5): ApiKeyStore, crypto, fs, hashToken(), safeEqual()

### Community 8 - "Send Queue (BullMQ)"
Cohesion: 0.18
Nodes (3): connection, { Queue, Worker, QueueEvents }, SendQueue

### Community 9 - "Public Dashboard Setup"
Cohesion: 0.36
Nodes (9): public-dashboard.sh script, install_public_dashboard(), need_root(), remove_public_dashboard(), set_env_value(), show_credentials(), status_public_dashboard(), usage() (+1 more)

### Community 10 - "Request Auth & Rate Limiting"
Cohesion: 0.24
Nodes (11): applySecurityHeaders(), bearerToken(), csrfAllowed(), hasDashboardAccess(), isAdminOnlyPath(), isAuthBlocked(), isDashboardAsset(), recordAuthFailure() (+3 more)

### Community 11 - "Dashboard Sessions"
Cohesion: 0.25
Nodes (11): cleanupDashboardSessions(), clearDashboardSession(), createDashboardPasswordSession(), createDashboardSession(), dashboardPasswordSession(), dashboardSession(), parseCookies(), passwordAuthEnabled() (+3 more)

### Community 12 - "Uninstall Script"
Cohesion: 0.46
Nodes (7): uninstall.sh script, confirm(), maybe_purge_packages(), remove_commands(), remove_files_and_user(), remove_public_dashboard(), remove_services()

### Community 13 - "OpenAPI Export"
Cohesion: 0.40
Nodes (5): baseUrl(), fs, main(), path, rootDir

### Community 14 - "OpenAPI Generate"
Cohesion: 0.40
Nodes (3): fs, path, rootDir

### Community 15 - "Messages Client Module"
Cohesion: 0.40
Nodes (4): { chromium }, { EventEmitter }, fs, path

### Community 19 - "Server Bootstrap"
Cohesion: 0.67
Nodes (3): loadSessions(), main(), startSendWorker()

### Community 20 - "Systemd Service Control"
Cohesion: 0.67
Nodes (3): runCommand(), serviceInfo(), systemctl()

## Knowledge Gaps
- **90 isolated node(s):** `name`, `version`, `private`, `description`, `main` (+85 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `GoogleMessagesClient` connect `Google Messages Automation` to `API Server Core`, `Messages Client Module`?**
  _High betweenness centrality (0.146) - this node is a cross-community bridge._
- **Why does `ApiKeyStore` connect `API Key Store` to `API Server Core`?**
  _High betweenness centrality (0.050) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _90 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Google Messages Automation` be split into smaller, more focused modules?**
  _Cohesion score 0.0899854862119013 - nodes in this community are weakly interconnected._
- **Should `Docs & Project Concepts` be split into smaller, more focused modules?**
  _Cohesion score 0.06666666666666667 - nodes in this community are weakly interconnected._
- **Should `Dashboard Frontend` be split into smaller, more focused modules?**
  _Cohesion score 0.10384615384615385 - nodes in this community are weakly interconnected._
- **Should `API Server Core` be split into smaller, more focused modules?**
  _Cohesion score 0.05555555555555555 - nodes in this community are weakly interconnected._