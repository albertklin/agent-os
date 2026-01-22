FROM node:20

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Install basic development tools and iptables/ipset
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  gh \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  tmux \
  locales \
  inotify-tools \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Configure UTF-8 locale for proper Unicode rendering
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# Ensure default node user has access to /usr/local/share
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share

ARG USERNAME=node

# Persist bash history.
RUN SNIPPET="export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  && mkdir /commandhistory \
  && touch /commandhistory/.bash_history \
  && chown -R $USERNAME /commandhistory

# Set `DEVCONTAINER` environment variable to help with orientation
ENV DEVCONTAINER=true

# Create workspace and config directories and set permissions
RUN mkdir -p /workspace /home/node/.claude && \
  chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

ARG GIT_DELTA_VERSION=0.18.2
RUN ARCH=$(dpkg --print-architecture) && \
  wget "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  sudo dpkg -i "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" && \
  rm "git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb"

# Set up non-root user
USER node

# Install global packages
ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
# Use absolute path for .local/bin to ensure it's in PATH for non-interactive shells (tmux commands)
ENV PATH=/home/node/.local/bin:$PATH:/usr/local/share/npm-global/bin

# Create .local/bin directory for native installers (Claude Code, etc.)
RUN mkdir -p /home/node/.local/bin

# Set the default shell to zsh rather than sh
ENV SHELL=/bin/zsh

# Set the default editor and visual
ENV EDITOR=nano
ENV VISUAL=nano

# Default powerline10k theme
ARG ZSH_IN_DOCKER_VERSION=1.2.0
RUN sh -c "$(wget -O- https://github.com/deluan/zsh-in-docker/releases/download/v${ZSH_IN_DOCKER_VERSION}/zsh-in-docker.sh)" -- \
  -p git \
  -p fzf \
  -a "source /usr/share/doc/fzf/examples/key-bindings.zsh" \
  -a "source /usr/share/doc/fzf/examples/completion.zsh" \
  -a "export PROMPT_COMMAND='history -a' && export HISTFILE=/commandhistory/.bash_history" \
  -a 'export PATH="$HOME/.local/bin:$PATH"' \
  -x

# Install Claude Code using native installer
RUN curl -fsSL https://claude.ai/install.sh | bash -s -- ${CLAUDE_CODE_VERSION} && \
  # Verify installation succeeded
  test -x /home/node/.local/bin/claude && \
  # Create symlink in /usr/local/bin as fallback for PATH issues
  sudo ln -sf /home/node/.local/bin/claude /usr/local/bin/claude


# Copy firewall script (executed via `docker exec -u root`, not sudo)
COPY init-firewall.sh /usr/local/bin/
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh

# Install git wrapper to restrict dangerous commands (checkout, branch -D, reset, etc.)
# Move real git binary and replace with wrapper
COPY git-wrapper.sh /usr/bin/git-wrapper.sh
RUN mv /usr/bin/git /usr/bin/git.real && \
  mv /usr/bin/git-wrapper.sh /usr/bin/git && \
  chmod +x /usr/bin/git

# Copy tmux configuration for proper terminal behavior
COPY tmux.conf /home/node/.tmux.conf
RUN chown node:node /home/node/.tmux.conf

USER node
