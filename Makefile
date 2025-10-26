build:
	vsce package
	@echo "Build completed."

link-lsp:
	npm link boriel-basic-lsp

unlink-lsp:
	npm unlink boriel-basic-lsp