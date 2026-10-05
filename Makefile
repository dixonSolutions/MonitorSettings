UUID := monitor-settings@dixonsolutions.github.io
SRC  := $(UUID)
DEST := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas test test-hw pack install uninstall lint clean

all: schemas

schemas:
	glib-compile-schemas --strict $(SRC)/schemas

test:
	gjs -m tests/run-tests.js

# Reads (and briefly writes, then restores) real monitor values
test-hw:
	gjs -m tests/hardware-test.js

pack: schemas
	mkdir -p dist
	gnome-extensions pack --force --extra-source=lib --out-dir=dist $(SRC)

install: pack
	gnome-extensions install --force dist/$(UUID).shell-extension.zip
	@echo "Installed. Log out and back in (Wayland), then: gnome-extensions enable $(UUID)"

uninstall:
	gnome-extensions uninstall $(UUID) || rm -rf $(DEST)

clean:
	rm -rf dist $(SRC)/schemas/gschemas.compiled
