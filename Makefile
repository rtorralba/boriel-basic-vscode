install-vsce:
	npm install -g vsce
	@echo "VSCE installed."
	
build:
	vsce package
	@echo "Build completed."

link-lsp:
	cd ../boriel-basic-lsp && npm link
	cd ../boriel-basic-vscode && npm link boriel-basic-lsp
	@echo "LSP linked."

unlink-lsp:
	npm unlink boriel-basic-lsp