#!/usr/bin/env bash
# Common utilities for agent-os scripts

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Logging
log_info() { echo -e "${BLUE}==>${NC} $1"; }
log_success() { echo -e "${GREEN}==>${NC} $1"; }
log_warn() { echo -e "${YELLOW}==>${NC} $1"; }
log_error() { echo -e "${RED}==>${NC} $1"; }

# OS Detection
detect_os() {
    case "$(uname -s)" in
        Darwin*)
            echo "macos"
            ;;
        Linux*)
            if [[ -f /etc/debian_version ]]; then
                echo "debian"
            elif [[ -f /etc/redhat-release ]]; then
                echo "redhat"
            else
                echo "linux"
            fi
            ;;
        *)
            echo "unknown"
            ;;
    esac
}

# Check if running interactively
is_interactive() {
    [[ -t 0 ]] && [[ -t 1 ]]
}

# Prompt for yes/no
prompt_yn() {
    local prompt="$1"
    local default="${2:-y}"

    if ! is_interactive; then
        [[ "$default" == "y" ]]
        return
    fi

    local yn_prompt
    if [[ "$default" == "y" ]]; then
        yn_prompt="[Y/n]"
    else
        yn_prompt="[y/N]"
    fi

    read -p "$prompt $yn_prompt " -r response
    response="${response:-$default}"

    [[ "$response" =~ ^[Yy] ]]
}

# Process management helpers
get_pid() {
    local pid_file="$AGENT_OS_HOME/agent-os.pid"
    if [[ -f "$pid_file" ]]; then
        local pid
        pid=$(cat "$pid_file")
        if kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
            return 0
        fi
    fi

    # Fallback: check for process on the port if PID file is stale/missing
    local port_pid
    port_pid=$(lsof -ti:"$PORT" 2>/dev/null | head -1)
    if [[ -n "$port_pid" ]]; then
        echo "$port_pid"
        return 0
    fi

    return 1
}

is_running() {
    get_pid &>/dev/null
}

# Get Tailscale IP if available
get_tailscale_ip() {
    if command -v tailscale &> /dev/null; then
        tailscale ip -4 2>/dev/null | head -1
    fi
}

# Configure host firewall to allow Docker containers to reach AgentOS
# This is required for status updates from sandboxed sessions to work
configure_docker_firewall() {
    local port="${1:-3011}"

    # Only needed on Linux - macOS doesn't have this issue
    if [[ "$(uname -s)" != "Linux" ]]; then
        return 0
    fi

    # Check if Docker is installed
    if ! command -v docker &>/dev/null; then
        return 0
    fi

    # Get Docker bridge network CIDR (usually 172.17.0.0/16)
    local docker_cidr
    docker_cidr=$(docker network inspect bridge -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' 2>/dev/null || echo "172.17.0.0/16")

    # Check if ufw is active
    if command -v ufw &>/dev/null && sudo ufw status 2>/dev/null | grep -q "Status: active"; then
        log_info "Configuring ufw to allow Docker containers to reach port $port..."

        # Check if rule already exists
        if ! sudo ufw status | grep -q "ALLOW.*$docker_cidr"; then
            sudo ufw allow from "$docker_cidr" to any port "$port" proto tcp comment "AgentOS from Docker" 2>/dev/null || {
                log_warn "Failed to add ufw rule. Docker container status updates may not work."
                log_warn "Manually run: sudo ufw allow from $docker_cidr to any port $port proto tcp"
                return 1
            }
            log_success "Added ufw rule for Docker containers"
        else
            log_info "ufw rule for Docker containers already exists"
        fi
        return 0
    fi

    # Check if firewalld is active
    if command -v firewall-cmd &>/dev/null && systemctl is-active firewalld &>/dev/null; then
        log_info "Configuring firewalld to allow Docker containers to reach port $port..."

        # Check if rule already exists (check for rich rule)
        if ! sudo firewall-cmd --list-rich-rules 2>/dev/null | grep -q "source address=\"$docker_cidr\".*port.*$port"; then
            sudo firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=$docker_cidr port port=$port protocol=tcp accept" 2>/dev/null || {
                log_warn "Failed to add firewalld rule. Docker container status updates may not work."
                return 1
            }
            sudo firewall-cmd --reload 2>/dev/null || true
            log_success "Added firewalld rule for Docker containers"
        else
            log_info "firewalld rule for Docker containers already exists"
        fi
        return 0
    fi

    # Check if iptables has INPUT DROP policy (indicating a firewall)
    if command -v iptables &>/dev/null; then
        local input_policy
        input_policy=$(sudo iptables -L INPUT -n 2>/dev/null | head -1 | grep -o "policy [A-Z]*" | awk '{print $2}')

        if [[ "$input_policy" == "DROP" ]] || [[ "$input_policy" == "REJECT" ]]; then
            log_info "Configuring iptables to allow Docker containers to reach port $port..."

            # Check if rule already exists
            if ! sudo iptables -C INPUT -s "$docker_cidr" -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
                sudo iptables -I INPUT -s "$docker_cidr" -p tcp --dport "$port" -j ACCEPT 2>/dev/null || {
                    log_warn "Failed to add iptables rule. Docker container status updates may not work."
                    log_warn "Manually run: sudo iptables -I INPUT -s $docker_cidr -p tcp --dport $port -j ACCEPT"
                    return 1
                }
                log_success "Added iptables rule for Docker containers"

                # Try to persist the rule
                if command -v iptables-save &>/dev/null && [[ -d /etc/iptables ]]; then
                    sudo iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
                fi
            else
                log_info "iptables rule for Docker containers already exists"
            fi
            return 0
        fi
    fi

    # No firewall detected or not blocking
    return 0
}
