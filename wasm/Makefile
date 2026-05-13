EMCC   = $(HOME)/.emsdk/upstream/emscripten/emcc
SRC    = processor.cpp
TARGET = ../processor.js

CFLAGS = \
	-O3 \
	-fno-exceptions \
	-fno-rtti \
	-s WASM=1 \
	-s MODULARIZE=1 \
	-s EXPORT_NAME='createProcessor' \
	-s EXPORTED_FUNCTIONS='["_floodFill","_traceBoundary","_simplifyRDP","_wasmAlloc","_wasmFree"]' \
	-s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]' \
	-s ALLOW_MEMORY_GROWTH=1 \
	-s INITIAL_MEMORY=67108864 \
	-s ENVIRONMENT='worker'

$(TARGET): $(SRC)
	$(EMCC) $(SRC) -o $(TARGET) $(CFLAGS)

clean:
	rm -f $(TARGET) ../processor.wasm
