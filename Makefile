# ==============================================================================
# Review Loop - Build Tools
# ==============================================================================
# Add `##` after a target to include it in the generated help output.
# Example:
#   target: ## Description shown by `make help`
#   	command
# ==============================================================================

.PHONY: ui
ui: ## Rebuild the Glimpse web UI
	pnpm run build:web

.PHONY: help
help: ## Show this help
	@echo 'Usage: make [target]'
	@echo ''
	@echo 'Targets:'
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)
