#!/bin/bash

# ============================================================
# GATECODE — Automated QA Scanner
# The bridge between GateTest, Claude, and GitHub.
#
# Usage:
#   ./gatecode.sh scan <url>              Scan a live site
#   ./gatecode.sh scan-repo <repo> <url>  Clone/pull repo, scan site + code, open dashboard
#   ./gatecode.sh setup <project> <url>   Install GateTest into a project
#   ./gatecode.sh watch <project> <url>   Continuous scan loop
#   ./gatecode.sh report <project>        Show latest scan report
#   ./gatecode.sh dashboard <project>     Open the HTML dashboard in browser
#   ./gatecode.sh status                  Show all monitored projects
#   ./gatecode.sh add <repo-url> <site-url>  Clone repo and set up GateTest
#
# Examples:
#   ./gatecode.sh scan https://zoobicon.com
#   ./gatecode.sh scan-repo https://github.com/user/repo https://their-site.com
#   ./gatecode.sh setup /home/user/Zoobicon.com https://zoobicon.com
#   ./gatecode.sh watch /home/user/Zoobicon.com https://zoobicon.com
#   ./gatecode.sh dashboard /home/user/Zoobicon.com
#   ./gatecode.sh add https://github.com/user/repo https://their-site.com
# ============================================================

set -e

GATECODE_DIR="$(cd "$(dirname "$0")" && pwd)"
GATECODE_DATA="$HOME/.gatecode"
GATECODE_PROJECTS="$GATECODE_DATA/projects.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

banner() {
    echo ""
    echo -e "${PURPLE}============================================================${NC}"
    echo -e "${WHITE}  GATECODE${NC} — Automated QA Scanner"
    echo -e "${PURPLE}============================================================${NC}"
    echo ""
}

# Ensure data directory exists
init_gatecode() {
    mkdir -p "$GATECODE_DATA"
    if [ ! -f "$GATECODE_PROJECTS" ]; then
        echo '{"projects":[]}' > "$GATECODE_PROJECTS"
    fi
}

# ============================================================
# SCAN — Crawl a live site and find every issue
# ============================================================
cmd_scan() {
    local url="$1"
    if [ -z "$url" ]; then
        echo -e "${RED}Usage: ./gatecode.sh scan <url>${NC}"
        echo "Example: ./gatecode.sh scan https://zoobicon.com"
        exit 1
    fi

    banner
    echo -e "${CYAN}  Scanning: ${WHITE}$url${NC}"
    echo ""

    node "$GATECODE_DIR/src/ai-loop.js" "$url"
    local exit_code=$?

    if [ $exit_code -eq 0 ]; then
        echo -e "${GREEN}  SCAN COMPLETE — ALL CLEAR${NC}"
    else
        echo -e "${RED}  SCAN COMPLETE — ISSUES FOUND${NC}"
        echo -e "${YELLOW}  Read: .gatetest/reports/fix-these.md${NC}"
    fi

    return $exit_code
}

# ============================================================
# SETUP — Install GateTest into a project
# ============================================================
cmd_setup() {
    local project="$1"
    local url="$2"

    if [ -z "$project" ]; then
        echo -e "${RED}Usage: ./gatecode.sh setup <project-path> <site-url>${NC}"
        echo "Example: ./gatecode.sh setup /home/user/Zoobicon.com https://zoobicon.com"
        exit 1
    fi

    banner
    node "$GATECODE_DIR/setup.js" "$project" "$url"

    # Register project
    init_gatecode
    local abs_project
    abs_project="$(cd "$project" 2>/dev/null && pwd || echo "$project")"
    local name
    name="$(basename "$abs_project")"
    local timestamp
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

    # Add to projects list (simple append to JSON)
    node -e "
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync('$GATECODE_PROJECTS', 'utf-8'));
        const existing = data.projects.findIndex(p => p.path === '$abs_project');
        const entry = {
            name: '$name',
            path: '$abs_project',
            url: '$url' || null,
            addedAt: '$timestamp',
            lastScan: null,
            lastStatus: null,
        };
        if (existing >= 0) {
            data.projects[existing] = { ...data.projects[existing], ...entry };
        } else {
            data.projects.push(entry);
        }
        fs.writeFileSync('$GATECODE_PROJECTS', JSON.stringify(data, null, 2));
    "

    echo -e "${GREEN}  Project registered with GateCode.${NC}"
}

# ============================================================
# WATCH — Continuous scan loop (scan, wait, repeat)
# ============================================================
cmd_watch() {
    local project="$1"
    local url="$2"
    local interval="${3:-300}" # Default 5 minutes

    if [ -z "$url" ]; then
        echo -e "${RED}Usage: ./gatecode.sh watch <project-path> <site-url> [interval-seconds]${NC}"
        echo "Example: ./gatecode.sh watch /home/user/Zoobicon.com https://zoobicon.com 300"
        exit 1
    fi

    banner
    echo -e "${CYAN}  Watching: ${WHITE}$url${NC}"
    echo -e "${CYAN}  Interval: ${WHITE}${interval}s${NC}"
    echo -e "${CYAN}  Press Ctrl+C to stop${NC}"
    echo ""

    local round=1
    while true; do
        echo -e "${PURPLE}--- Round $round — $(date '+%Y-%m-%d %H:%M:%S') ---${NC}"

        cd "$project"
        node "$GATECODE_DIR/src/ai-loop.js" "$url" 2>&1
        local exit_code=$?

        # Update project status
        init_gatecode
        local abs_project
        abs_project="$(cd "$project" && pwd)"
        local timestamp
        timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        local status="clean"
        [ $exit_code -ne 0 ] && status="issues"

        node -e "
            const fs = require('fs');
            const data = JSON.parse(fs.readFileSync('$GATECODE_PROJECTS', 'utf-8'));
            const p = data.projects.find(p => p.path === '$abs_project');
            if (p) { p.lastScan = '$timestamp'; p.lastStatus = '$status'; }
            fs.writeFileSync('$GATECODE_PROJECTS', JSON.stringify(data, null, 2));
        " 2>/dev/null

        if [ $exit_code -eq 0 ]; then
            echo -e "${GREEN}  ALL CLEAR — next scan in ${interval}s${NC}"
        else
            echo -e "${RED}  ISSUES FOUND — next scan in ${interval}s${NC}"
            echo -e "${YELLOW}  Fix issues and they'll be verified on next scan${NC}"
        fi

        echo ""
        round=$((round + 1))
        sleep "$interval"
    done
}

# ============================================================
# REPORT — Show latest scan report for a project
# ============================================================
cmd_report() {
    local project="${1:-.}"
    local report_path="$project/.gatetest/reports/fix-these.md"

    if [ ! -f "$report_path" ]; then
        echo -e "${YELLOW}No scan report found. Run a scan first:${NC}"
        echo "  ./gatecode.sh scan <url>"
        exit 1
    fi

    banner
    cat "$report_path"
}

# ============================================================
# STATUS — Show all monitored projects
# ============================================================
cmd_status() {
    init_gatecode
    banner

    echo -e "${WHITE}  Monitored Projects${NC}"
    echo ""

    node -e "
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync('$GATECODE_PROJECTS', 'utf-8'));
        if (data.projects.length === 0) {
            console.log('  No projects registered. Run: ./gatecode.sh setup <path> <url>');
            return;
        }
        for (const p of data.projects) {
            const status = p.lastStatus === 'clean' ? '\x1b[32m● CLEAN\x1b[0m' :
                           p.lastStatus === 'issues' ? '\x1b[31m● ISSUES\x1b[0m' :
                           '\x1b[33m● NOT SCANNED\x1b[0m';
            console.log('  ' + status + '  ' + p.name);
            if (p.url) console.log('         URL:  ' + p.url);
            console.log('         Path: ' + p.path);
            if (p.lastScan) console.log('         Last: ' + p.lastScan);
            console.log('');
        }
    "
}

# ============================================================
# ADD — Clone a repo and set up GateTest in one step
# ============================================================
cmd_add() {
    local repo_url="$1"
    local site_url="$2"

    if [ -z "$repo_url" ]; then
        echo -e "${RED}Usage: ./gatecode.sh add <repo-url> <site-url>${NC}"
        echo "Example: ./gatecode.sh add https://github.com/user/repo https://their-site.com"
        exit 1
    fi

    banner

    # Extract repo name
    local repo_name
    repo_name="$(basename "$repo_url" .git)"
    local clone_path="$HOME/$repo_name"

    if [ -d "$clone_path" ]; then
        echo -e "${YELLOW}  Repo already exists at $clone_path — updating...${NC}"
        cd "$clone_path" && git pull 2>/dev/null || true # gatetest:swallow-ok reason="non-fatal repo update — script continues regardless of network"
    else
        echo -e "${CYAN}  Cloning $repo_url...${NC}"
        git clone "$repo_url" "$clone_path"
    fi

    echo ""
    cmd_setup "$clone_path" "$site_url"
}

# ============================================================
# SCAN-REPO — Clone/pull a repo, run full code + site scan, open dashboard
# ============================================================
cmd_scan_repo() {
    local repo_url="$1"
    local site_url="$2"
    local suite="${3:-full}"

    if [ -z "$repo_url" ]; then
        echo -e "${RED}Usage: ./gatecode.sh scan-repo <repo-url> [site-url] [suite]${NC}"
        echo "Example: ./gatecode.sh scan-repo https://github.com/user/repo https://their-site.com"
        exit 1
    fi

    banner

    # Clone or pull the repo
    local repo_name
    repo_name="$(basename "$repo_url" .git)"
    local clone_path="$HOME/$repo_name"

    if [ -d "$clone_path" ]; then
        echo -e "${CYAN}  Pulling latest: ${WHITE}$repo_name${NC}"
        cd "$clone_path" && git pull 2>/dev/null || true # gatetest:swallow-ok reason="non-fatal repo update — script continues regardless of network"
    else
        echo -e "${CYAN}  Cloning: ${WHITE}$repo_url${NC}"
        git clone "$repo_url" "$clone_path"
    fi

    # Set up GateTest if not already done
    if [ ! -d "$clone_path/.gatetest" ]; then
        echo -e "${CYAN}  Installing GateTest...${NC}"
        cmd_setup "$clone_path" "$site_url"
    fi

    echo ""
    echo -e "${CYAN}  Running full code scan (${suite} suite)...${NC}"
    echo ""

    # Run code analysis
    cd "$clone_path"
    node "$GATECODE_DIR/bin/gatetest.js" --suite "$suite" --project "$clone_path" 2>&1

    # Run live site scan if URL provided
    if [ -n "$site_url" ]; then
        echo ""
        echo -e "${CYAN}  Crawling live site: ${WHITE}$site_url${NC}"
        echo ""
        node "$GATECODE_DIR/src/ai-loop.js" "$site_url" 2>&1 || true # gatetest:swallow-ok reason="live crawl is best-effort — site may be unreachable; scan continues regardless"
    fi

    # Update project registry
    local timestamp
    timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    node -e "
        const fs = require('fs');
        const data = JSON.parse(fs.readFileSync('$GATECODE_PROJECTS', 'utf-8'));
        const existing = data.projects.findIndex(p => p.path === '$clone_path');
        const entry = {
            name: '$repo_name',
            path: '$clone_path',
            url: '$site_url' || null,
            repo: '$repo_url',
            addedAt: '$timestamp',
            lastScan: '$timestamp',
            lastStatus: 'scanned',
        };
        if (existing >= 0) {
            data.projects[existing] = { ...data.projects[existing], ...entry };
        } else {
            data.projects.push(entry);
        }
        fs.writeFileSync('$GATECODE_PROJECTS', JSON.stringify(data, null, 2));
    " 2>/dev/null

    # Open dashboard
    local dashboard="$clone_path/.gatetest/reports/gatetest-report-latest.html"
    if [ -f "$dashboard" ]; then
        echo ""
        echo -e "${GREEN}  ============================================================${NC}"
        echo -e "${GREEN}  SCAN COMPLETE — Dashboard ready${NC}"
        echo -e "${GREEN}  ============================================================${NC}"
        echo ""
        echo -e "  ${WHITE}Dashboard:${NC} $dashboard"
        echo -e "  ${WHITE}Report:${NC}    $clone_path/.gatetest/reports/fix-these.md"
        echo ""
        echo -e "  Open the dashboard in your browser to see the checklist."
        echo ""

        # Try to open in browser (works on Mac/Linux)
        if command -v open &>/dev/null; then
            open "$dashboard"
        elif command -v xdg-open &>/dev/null; then
            xdg-open "$dashboard"
        fi
    fi
}

# ============================================================
# DASHBOARD — Open the HTML dashboard for a project
# ============================================================
cmd_dashboard() {
    local project="${1:-.}"
    local dashboard="$project/.gatetest/reports/gatetest-report-latest.html"

    if [ ! -f "$dashboard" ]; then
        echo -e "${YELLOW}No dashboard found. Run a scan first:${NC}"
        echo "  ./gatecode.sh scan-repo <repo-url> <site-url>"
        exit 1
    fi

    banner
    echo -e "  ${WHITE}Opening dashboard:${NC} $dashboard"
    echo ""

    # Try to open in browser
    if command -v open &>/dev/null; then
        open "$dashboard"
    elif command -v xdg-open &>/dev/null; then
        xdg-open "$dashboard"
    else
        echo "  Open this file in your browser:"
        echo "  file://$dashboard"
    fi
}

# ============================================================
# HELP
# ============================================================
cmd_help() {
    banner
    echo "  Commands:"
    echo ""
    echo -e "    ${WHITE}scan-repo${NC} <repo> <url>          Clone repo, scan code + site, open dashboard"
    echo -e "    ${WHITE}scan${NC} <url>                      Scan a live website only"
    echo -e "    ${WHITE}dashboard${NC} <project>             Open the HTML dashboard in browser"
    echo -e "    ${WHITE}setup${NC} <project> <url>           Install GateTest into a project"
    echo -e "    ${WHITE}watch${NC} <project> <url> [secs]    Continuous scan loop"
    echo -e "    ${WHITE}report${NC} <project>                Show latest scan report"
    echo -e "    ${WHITE}status${NC}                          Show all monitored projects"
    echo -e "    ${WHITE}add${NC} <repo-url> <site-url>       Clone repo and set up GateTest"
    echo -e "    ${WHITE}help${NC}                            Show this help"
    echo ""
    echo "  Quick start (one command does everything):"
    echo ""
    echo -e "    ${GREEN}./gatecode.sh scan-repo https://github.com/you/repo https://your-site.com${NC}"
    echo ""
    echo "  This will: clone the repo, install GateTest, scan the code,"
    echo "  crawl the live site, and open the dashboard with a checklist"
    echo "  of every issue found. Tick them off as you fix them."
    echo ""
    echo "  More examples:"
    echo ""
    echo "    ./gatecode.sh scan https://onbookaride.co.nz"
    echo "    ./gatecode.sh scan-repo https://github.com/user/repo https://site.com"
    echo "    ./gatecode.sh dashboard ~/Zoobicon.com"
    echo "    ./gatecode.sh watch ~/Zoobicon.com https://zoobicon.com 300"
    echo "    ./gatecode.sh status"
    echo ""
}

# ============================================================
# MAIN
# ============================================================
init_gatecode

case "${1:-help}" in
    scan-repo)  cmd_scan_repo "$2" "$3" "$4" ;;
    scan)       cmd_scan "$2" ;;
    dashboard)  cmd_dashboard "$2" ;;
    setup)      cmd_setup "$2" "$3" ;;
    watch)      cmd_watch "$2" "$3" "$4" ;;
    report)     cmd_report "$2" ;;
    status)     cmd_status ;;
    add)        cmd_add "$2" "$3" ;;
    help|*)     cmd_help ;;
esac
