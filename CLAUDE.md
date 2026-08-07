# IDTAP Web Development Guide

## Overview
IDTAP (Interactive Digital Transcription and Analysis Platform) is a sophisticated full-stack web application for musical transcription and analysis, specifically focused on Indian classical music. The system combines modern web technologies with specialized audio processing and visualization capabilities.

**Key Features:**
- **Polyphonic Individual Instrumentality** - Dual-string support for Sitar and Sarangi instruments
- **Python API Integration** - PyPI package with OAuth authentication for programmatic access
- **Research Integration** - Academic paper accessibility and waiver system
- **Advanced Musical Notation** - Microtonal pitch representation with raga-based theoretical framework
- **Real-time Audio Synthesis** - Physical modeling synthesis engines for Indian instruments

**Note:** This CLAUDE.md covers the web development aspects. For Python API development, see `/python/CLAUDE.md`.

## **CRITICAL: Server Management Rules**

**⚠️ NEVER RESTART THE PRODUCTION SERVER WITHOUT EXPLICIT PERMISSION ⚠️**

Production runs on the CSAIL box (`idtap.csail.mit.edu` / `128.52.132.248`, SSH alias `idtap-csail`) as the **`idtap` systemd service**, deployed from `/opt/idtap/app`:
- **NEVER** manually restart, kill, or interfere with the server process
- **NEVER** run commands like `sudo systemctl restart idtap`, `pkill node`, or similar
- Deploys restart the service automatically via the GitHub Actions workflow
- If the service needs restarting outside a deploy, the user will handle it

**Deployment workflow:**
1. Merge to `main` (via PR) — the self-hosted runner on the box builds and deploys automatically
2. The workflow restarts the `idtap` service and health-checks it
3. DO NOT attempt any manual server restart

**If the server is down:**
- Inform the user immediately
- DO NOT attempt to start it yourself

**Checking service status (safe, read-only):**
```bash
ssh idtap-csail "systemctl status idtap --no-pager"
```

## Technology Stack

### Frontend
- **Vue 3** with TypeScript - Main application framework
- **Vite** - Build tool and development server  
- **Vue Router 4** - Client-side routing
- **Vuex 4** - State management
- **D3.js** - Data visualization and interactive graphics
- **GSAP** - Animations
- **Web Audio API** with AudioWorklets - Real-time audio processing
- **Google OAuth** (vue3-google-login) - Authentication

### Backend  
- **Node.js** with **TypeScript** - Modern server runtime (legacy CommonJS server being phased out)
- **Express.js** - Web server framework
- **MongoDB** (self-hosted on the production box, `localhost:27017`, db `swara`) - Primary database
- **Google OAuth 2.0** with **JWT** - Authentication (enhanced for Python API integration)
- **Python 3** integration - Audio processing and visualization generation
- **FFmpeg** - Audio format conversion

### Key Dependencies
- Audio: @soundtouchjs/audio-worklet, rubberband-web, soundtouchjs
- Music notation: vexflow
- Data: lodash, d3, exceljs, jszip, pako
- Scientific: tensorflow.js, ndarray libraries

## Database Structure (MongoDB)

### Core Collections
- **transcriptions** - Musical transcription data with complex nested structures
- **audioFiles** - Audio file metadata
- **users** - User profiles and authentication
- **musicians** - Musician database with gharana information
- **ragas** - Raga definitions and musical rules
- **collections** - User-created collections of transcriptions/recordings

### Permission System
- Public/private visibility levels
- Explicit permissions with granular edit/view access
- Owner-based access control
- Collection-based permission inheritance
- **Research waiver system** - Consent tracking for Python API access
- **JWT-based authentication** - Secure token-based access for programmatic clients

## API Architecture

### Authentication Endpoints
- `/userLoginGoogle` - Google OAuth login (web client)
- `/handleGoogleAuthCode` - Token exchange (web client)
- `/oauth/authorize` - OAuth authorization for Python API clients
- `/oauth/token` - JWT token generation for Python API clients
- `/api/agreeToWaiver` - Research waiver consent tracking

### Transcription Management
- `/insertNewTranscription` - Create new transcription
- `/updateTranscription` - Update existing
- `/getAllTranscriptions` - List with permissions
- `/api/transcription/:id` - RESTful single transcription access
- Clone, delete, and permission update endpoints

### Audio Processing
- `/newUploadFile` - Upload with progress tracking (web client)
- `/api/audio/upload` - Programmatic audio upload for Python API clients
- `/api/audio/metadata` - Audio file metadata endpoints
- `/makeSpectrograms` - Generate visualizations via Python
- `/makeMelograph` - Generate melodic contour analysis
- Audio format conversion pipeline (opus → wav)

### Data Export
- `/excelData` - Excel export generation
- `/jsonData` - JSON export
- `/DNExtractExcel` - Advanced data extraction

## Polyphonic Individual Instrumentality System

### Overview
The Polyphonic Individual Instrumentality system enables dual-string support for Sitar and Sarangi instruments, allowing simultaneous transcription and playback of multiple melodic lines within a single instrument track.

### Architecture
- **String-indexed trajectory grids** - `trajectoryGrid[0]` (main string) and `trajectoryGrid[1]` (second string)
- **Automatic synchronization** - Silent trajectory generation to maintain temporal alignment
- **Cross-string coordination** - Phrase division operations affect both strings simultaneously
- **String-aware editing** - Selection, deletion, and modification operations respect string boundaries

### Key Components
- **Piece.ensureStringSynchronization()** - Maintains temporal alignment between strings
- **Piece.stringFromTraj()** - Determines which string contains a given trajectory
- **Phrase.trajectoryGrid** - Multi-dimensional trajectory storage (track → string → trajectories)
- **String mode selector** - UI component for switching between string views

### Supported Instruments
- **Sitar** - Main string (melody) + Jor string (secondary melody/drone)
- **Sarangi** - Main string (melody) + Second string (harmony/accompaniment)

### Integration Points
- **Audio synthesis** - Separate AudioWorklet nodes for each string
- **Visual rendering** - String-aware trajectory display and selection
- **MIDI/Audio export** - Multi-channel output for polyphonic content
- **Analysis tools** - String-specific pitch analysis and visualization

## Frontend Architecture

### Component Organization
```
src/
├── Editor/              # Main transcription editor
├── AudioRecordings/     # Audio management interface
├── Collections/         # Collection management
├── Analysis/           # Data analysis tools
└── Files/              # File management
```

### Key Components
- **EditorComponent.vue** - Main editor interface with complex state management and polyphonic support
- **Renderer.vue** - Canvas-based visualization renderer with string-aware rendering
- **EditorAudioPlayer.vue** - Custom audio player with Web Audio API
- **TranscriptionLayer.vue** - Musical notation rendering with dual-string trajectory support
- **SpectrogramLayer.vue** - Real-time spectrogram visualization
- **ModeSelector.vue** - Generic mode selection component with tooltip system (used for string selection)
- **TrajSelectPanel.vue** - Trajectory selection interface with polyphonic awareness
- **XAxis.vue** - Time axis display with excerpt/real time toggle support

### State Management
- Vuex store for authentication state
- Component-level reactive state
- Event bus (mitt) for cross-component communication
- Local storage for user preferences

## Audio Processing System

### Synthesis Engines
- **Karplus-Strong** - Plucked string synthesis (sitar main string + jor string)
- **Klatt synthesizer** - Vocal synthesis
- **Sarangi** - Physical modeling synthesis (main string + second string)
- **Chikari** - Drone string synthesis with 4-string support
- Real-time parameter control via AudioWorklet
- **Polyphonic audio routing** - Separate AudioWorklet nodes for each string with mixed output
- **String-specific gain control** - Independent volume control for main and secondary strings

### Audio Pipeline
1. Client upload with progress tracking
2. Server processing with express-fileupload
3. FFmpeg format conversion
4. Python analysis pipeline
5. Automatic visualization generation
6. File storage organization

## Development Workflow

### **CRITICAL: Git Branching Strategy**
**⚠️ NEVER PUSH DIRECTLY TO MAIN BRANCH ⚠️**

**Always use feature branches and pull requests:**
1. **Create feature branch**: `git checkout -b feature/your-feature-name`
2. **Make changes and commit**: `git add . && git commit -m "feat: your changes"`
3. **Push branch**: `git push origin feature/your-feature-name`
4. **Create Pull Request**: Use GitHub UI or `gh pr create`
5. **Review and merge**: After review, merge PR to main

**Why this matters:**
- **Auto-deployment**: Main branch triggers automatic frontend deployment to production
- **Code review**: PRs ensure code quality and catch issues before production
- **CI/CD safety**: Branch protection prevents broken deployments
- **Collaboration**: Team can review changes before they go live

**The only exception**: Emergency hotfixes (but still prefer PRs when possible)

### Build Commands
```bash
pnpm dev             # Vite development server
pnpm build           # Production build  
pnpm serve           # Preview production build
pnpm test            # Vitest test runner
```

### Testing Setup
- **Vitest** for unit testing
- Component testing for Vue components
- API route testing with supertest
- Coverage reporting with @vitest/coverage-v8

### Code Quality
- **ESLint** for JavaScript/TypeScript linting
- **TypeScript** strict mode enforcement
- Vue 3 Composition API patterns

## GitHub Workflows and Automation

### Claude PR Review System
- **Manual trigger** - Comment `@claude review` on any PR for AI-powered code review
- **Automated review** - GitHub Actions workflow with sticky comment updates
- **Security model** - Read-only permissions with proper secret handling
- **Integration** - Works with conventional commit patterns and changelog generation

### Automated Development Workflows
- **`claude-review.yml`** - Manual PR review trigger workflow
- **`claude.yml`** - General Claude integration for issues and PRs
- **Dependency management** - Automated security updates and vulnerability scanning
- **Quality gates** - TypeScript compilation and linting checks in CI/CD

### Conventional Commit Integration
- **Changelog automation** - Conventional commits (`feat:`, `fix:`, `chore:`) trigger changelog updates
- **Version management** - Semantic versioning based on commit types
- **Release automation** - Automated tagging and release note generation

## Security Implementation

### Authentication Flow
- **Web clients** - Client-side Google OAuth via vue3-google-login with server-side verification
- **Python API clients** - OAuth 2.0 authorization code flow with JWT token exchange
- **Token management** - Secure storage with keyring (primary) and encrypted file fallback
- **Waiver system** - Research participation consent required for API access
- **Automatic user registration** - Seamless onboarding for new users

### Security Measures
- **CORS configuration** - Properly configured cross-origin resource sharing
- **Request timeouts** - 10 minutes for analysis operations, shorter for standard requests
- **File upload limits** - 1GB maximum file size with validation
- **Input validation** - Comprehensive sanitization of user inputs
- **MongoDB security** - Query parameter sanitization and injection prevention
- **Dependency scanning** - Automated vulnerability detection and updates
- **Secret management** - Secure handling of API keys and authentication tokens

## Visualization System

### Rendering Architecture
- SVG/Canvas hybrid rendering approach
- D3.js for data binding and transformations
- 50+ scientific colormaps for spectrogram visualization
- Interactive zoom and pan functionality
- Real-time audio-visual synchronization

### Musical Transcription Features
- **Continuous melodic trajectory system** with polyphonic string support
- **Microtonal pitch representation** with cents-based precision
- **Multi-instrument simultaneous transcription** across multiple tracks
- **Polyphonic individual instrumentality** - Dual-string support for Sitar and Sarangi
- **Raga-based theoretical framework** with pitch class analysis
- **Spectrogram-guided transcription workflow** with real-time audio feedback
- **Timing display modes** - Toggle between excerpt time and real time display
- **Musical time calculations** - Pulse-based meter analysis with hierarchical reference levels

## Deployment

### Build Process
- Vite handles ES module bundling
- TypeScript compilation with strict typing
- Audio worklet assets handling
- Source maps for debugging

### Deployment

#### Automated Deployment (GitHub Actions)
**All deployment (frontend + server)** is automated via `.github/workflows/update-changelog.yml`:
- **Triggers**: Push to `main` branch (or manual `workflow_dispatch` re-deploy)
- **Runner**: Self-hosted GitHub Actions runner installed ON the CSAIL box (label `idtap-csail`) — the CSAIL border firewall blocks inbound SSH, so the runner sidesteps it with outbound-only connections
- **Build**: `pnpm install` → `pnpm build` (Vite frontend) → `pnpm buildServer` (esbuild server bundle)
- **Deploy**: Sync `dist/` and `server.js` into `/opt/idtap/app`, then restart the `idtap` systemd service with a health check
- **Changelog**: Automatically generated from conventional commits (`feat:`, `fix:`, etc.)

There are **no manual deploy scripts** anymore — the old `pnpm deploy*` rsync commands targeted the retired DigitalOcean server and have been removed. Do not re-add rsync deploys to `137.184.90.119` (account closed) or `root@swara.studio`.

#### Build Process for Server
- **esbuild** bundles `server/server.ts` → `server/build/server.js` (`pnpm buildServer`)
- **esbuild** compiles `extract.ts` → `extract.js` for data processing (`pnpm buildExtract`)
- **Modular server architecture**: `server.ts`, `apiRoutes.ts`, `oauthRoutes.ts`

#### Deployment Infrastructure
- **Production server**: `idtap.csail.mit.edu` (`128.52.132.248`), SSH alias `idtap-csail` — MIT CSAIL OpenStack
- **Production domain**: `swara.studio` — DNS hosted on Squarespace, A record → CSAIL box
- **App dir**: `/opt/idtap/app`, run by the `idtap` systemd service (service user `jonmyers`, a CSAIL LDAP account)
- **Storage**: CSAIL NFS export at `/data/hai-res/idtap` (media, backups, external recordings); NFS writes require `sudo -u '#29460'` (the `jonmyers` UID)
- **CI/CD**: GitHub Actions with a self-hosted runner on the box

## Key Patterns and Conventions

### Frontend Patterns
- Vue 3 Composition API with `<script setup>`
- TypeScript interfaces for type safety
- Composable functions for reusable logic
- Event-driven architecture
- Reactive data binding with computed properties

### Backend Patterns
- Express middleware for authentication
- MongoDB aggregation pipelines
- Async/await error handling
- RESTful API design principles
- Microservice integration with Python

### Data Flow
- Client → Server → MongoDB for persistence
- Client → Python scripts for analysis
- Real-time audio processing in browser
- File system integration for audio/visualization

## Performance Optimizations

- Web Workers for heavy computation
- AudioWorklet for low-latency audio processing  
- Canvas-based rendering for smooth graphics
- Lazy loading of visualizations
- Efficient MongoDB queries with proper indexing
- Progressive Web App capabilities

## Python API and Research Integration

### PyPI Package Distribution
- **Package name** - `idtap-api` available on PyPI for public installation
- **OAuth integration** - Seamless authentication with IDTAP web application
- **Data classes** - Structured Python objects for transcription data manipulation
- **Audio upload** - Programmatic audio file upload with metadata handling

### Research Framework
- **Waiver system** - Research participation consent tracking and validation
- **Academic papers** - ISMIR 2025 research paper and NEH whitepaper accessibility
- **Git LFS integration** - Large file storage for research documents and media
- **Institutional access** - API endpoints designed for academic and research use

### Data Access Patterns
- **Authenticated queries** - JWT-based secure access to transcription data
- **Metadata endpoints** - Comprehensive transcription and audio file metadata
- **Export formats** - JSON, Excel, and custom format support for analysis
- **Batch operations** - Efficient bulk data access for research workflows

### Integration with Analysis Tools
- **Python data science stack** - Compatible with pandas, numpy, matplotlib
- **Audio analysis** - Integration with librosa, essentia, and other audio libraries
- **Machine learning** - Prepared datasets for computational musicology research
- **Visualization** - Export-ready data for academic publication graphics

## Integration Points

### Python Integration
- **Server-side processing** - Python scripts for audio analysis and visualization generation
- **API client access** - PyPI package for programmatic data access and manipulation
- **Spectrogram and melograph generation** - Automated visualization pipeline
- **Audio format conversion** - FFmpeg integration for format standardization
- **Data exchange** - JSON serialization with structured data classes
- **Research workflows** - OAuth-authenticated access for academic and institutional use

### File System
- Organized audio storage by ID
- Generated visualization caching
- User-uploaded file management
- Temporary file cleanup

## Database Backup and Restoration

### Backup System
Daily MongoDB backups live on the CSAIL NFS export at `/data/hai-res/idtap/backups/`:
```
/data/hai-res/idtap/backups/
├── mongo/                            # Gzipped mongodump archives
│   └── swara-YYYYMMDD-HHMMSS.archive.gz
├── do-archive/                       # Historical DigitalOcean-era backups (2022-12 → 2026-07)
│   └── YYYY-M-D/swara/*.bson         # Old per-collection mongodump format
├── backup_mongo.sh                   # Daily dump script (runs as jonmyers)
├── prune_backups.py                  # GFS retention: daily 14d / weekly 12w / monthly 24m / yearly forever
└── systemd/                          # idtap-mongo-backup.service + .timer (daily 04:30 ET)
```

The `idtap-mongo-backup.timer` systemd timer runs `backup_mongo.sh` daily at 04:30 ET: it dumps the local `swara` DB (`mongodump --gzip --archive`) to NFS, then applies GFS retention via `prune_backups.py`. NFS writes require the `jonmyers` UID (`sudo -u '#29460'`).

### Restoration Process

#### 1. **Exploring Backups**
```bash
ssh idtap-csail
ls /data/hai-res/idtap/backups/mongo/                 # current archives
ls /data/hai-res/idtap/backups/do-archive/            # historical daily dumps
```

#### 2. **Full Database Restoration**
```bash
# Restore an archive to a test database (RECOMMENDED)
mongorestore --host=127.0.0.1 --nsFrom='swara.*' --nsTo='test_restore_YYYY_MM_DD.*' \
             --gzip --archive=/data/hai-res/idtap/backups/mongo/swara-YYYYMMDD-HHMMSS.archive.gz

# Restore to production database (USE WITH CAUTION)
mongorestore --host=127.0.0.1 --drop \
             --gzip --archive=/data/hai-res/idtap/backups/mongo/swara-YYYYMMDD-HHMMSS.archive.gz

# Historical DO-era backups use the directory format instead:
mongorestore --host=127.0.0.1 --nsFrom='swara.*' --nsTo='test_restore_YYYY_MM_DD.*' \
             /data/hai-res/idtap/backups/do-archive/YYYY-M-D/swara/
```

#### 3. **Single Document Recovery**
```bash
# Export a specific document from a restored test database
mongoexport --host=127.0.0.1 --db=test_restore_DB --collection=transcriptions \
            --query='{"_id": {"$oid": "DOCUMENT_ID"}}' --out=/tmp/specific_document.json

# Import to live database
mongoimport --host=127.0.0.1 --db=swara --collection=transcriptions \
            --file=/tmp/specific_document.json --upsert
```

#### 4. **Finding Lost Data**
```bash
# Search historical DO-era per-collection dumps by document ID or content
for backup in /data/hai-res/idtap/backups/do-archive/2023-*/swara/; do
    bsondump "$backup/transcriptions.bson" 2>/dev/null | grep -q "DOCUMENT_ID" && echo "Found in $backup"
done
```

#### 5. **Permission Field Evolution**
IDTAP's permission system has evolved:
- **Legacy**: `"permissions": "Public"` (string field)
- **Current**: `"explicitPermissions": {"edit":["userId"], "view":[], "publicView":true}` (object field)

When restoring older transcriptions, you may need to migrate permissions:
```javascript
// Example permission migration
{
  "permissions": "Public"  // Old format
}
// becomes:
{
  "explicitPermissions": {
    "edit": [],
    "view": [],
    "publicView": true
  }
}
```

### Best Practices
1. **Always test with a separate database first**: Use `test_restore_YYYY_MM_DD` naming
2. **Verify restored data** (e.g. `mongosh` queries against the test database) before applying to production
3. **Document the restoration**: Note which backup date was used and why
4. **Check for schema changes**: Newer fields like `explicitPermissions` may not exist in older backups
5. **Coordinate with team**: Ensure no one is actively editing during restoration

### Backup Retention
- **Current backups**: Daily gzipped archives with GFS retention (daily 14d → weekly 12w → monthly 24m → yearly forever)
- **Historical archive**: `do-archive/` holds the DigitalOcean-era daily dumps (2022-12-10 → 2026-07) in per-collection BSON format
- **Storage**: CSAIL NFS export at `/data/hai-res/idtap/backups/` (itself backed up by CSAIL infrastructure)
- **Collections**: All `swara` database collections backed up daily

This backup system ensures data recovery capabilities and supports research workflows requiring access to historical transcription data.