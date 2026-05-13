#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <vector>
#include <algorithm>
#include <emscripten.h>

extern "C" {

EMSCRIPTEN_KEEPALIVE void* wasmAlloc(int bytes) { return malloc(bytes); }
EMSCRIPTEN_KEEPALIVE void  wasmFree(void* ptr)  { free(ptr); }

// FLOODFILL
// 4-connected
// pxs : RGBA, width*height*4 bytes
// mask : width*height bytes

EMSCRIPTEN_KEEPALIVE
int floodFill(
    const uint8_t* pixels, int width, int height,
    int seedX, int seedY, float tolerance,
    uint8_t* mask
) {
    if (seedX < 0 || seedX >= width || seedY < 0 || seedY >= height) return 0;

    const int seedPos = seedY * width + seedX;
    const uint8_t* sc = pixels + seedPos * 4;
    const float sr = sc[0], sg = sc[1], sb = sc[2];

    std::vector<int> stack;
    stack.reserve(65536);
    stack.push_back(seedPos);
    mask[seedPos] = 1;
    int filled = 1;

    while (!stack.empty()) {
        const int pos = stack.back(); stack.pop_back();
        const int x = pos % width;
        const int y = pos / width;

        const int neighbours[4] = {
            (y > 0)          ? pos - width : -1,
            (y < height - 1) ? pos + width : -1,
            (x > 0)          ? pos - 1     : -1,
            (x < width - 1)  ? pos + 1     : -1,
        };

        for (int n : neighbours) {
            if (n < 0 || mask[n]) continue;
            const uint8_t* c = pixels + n * 4;
            const float dr = c[0] - sr, dg = c[1] - sg, db = c[2] - sb;
            if (dr*dr + dg*dg + db*db <= tolerance * tolerance) {
                mask[n] = 1;
                stack.push_back(n);
                ++filled;
            }
        }
    }
    return filled;
}

// MARCHING SQUARES
// Operates on px-grid corners
// For each filled px:
// 1. Find boundary edges
// 2. Walk adjacency graph to produce polygon
// 
// Corner (cx, cy) = intersection of pxs (cx-1,cy-1), (cx,cy-1), (cx-1,cy), (cx,cy)
//Output coordinates are in corner space [0..width] ×
// [0..height]; the caller scales back to native pixels.

EMSCRIPTEN_KEEPALIVE
int traceBoundary(
    const uint8_t* mask, int width, int height,
    float* outXY, int maxPairs
) {
    const int cw = width + 1;             // corner-grid width
    const int numCorners = cw * (height + 1);

    // Boundary corners capped at 4 bc of thin-protrusion edge cases
    std::vector<int>              adj_n(numCorners, 0);
    std::vector<std::array<int,4>> adj_c(numCorners);

    auto addEdge = [&](int c1, int c2) {
        if (adj_n[c1] < 4) adj_c[c1][adj_n[c1]++] = c2;
        if (adj_n[c2] < 4) adj_c[c2][adj_n[c2]++] = c1;
    };

    for (int py = 0; py < height; ++py) {
        for (int px = 0; px < width; ++px) {
            if (!mask[py * width + px]) continue;

            const int tl = py * cw + px;
            const int tr = py * cw + (px + 1);
            const int bl = (py + 1) * cw + px;
            const int br = (py + 1) * cw + (px + 1);

            // Top edge
            if (py == 0          || !mask[(py - 1) * width + px])       addEdge(tl, tr);
            // Bottom edge
            if (py == height - 1 || !mask[(py + 1) * width + px])       addEdge(bl, br);
            // Left edge
            if (px == 0          || !mask[py * width + (px - 1)])       addEdge(tl, bl);
            // Right edge
            if (px == width - 1  || !mask[py * width + (px + 1)])       addEdge(tr, br);
        }
    }

    // Find corner
    int start = -1;
    for (int i = 0; i < numCorners; ++i) {
        if (adj_n[i] >= 2) { start = i; break; }
    }
    if (start < 0) return 0;

    // Walk boundary
    int count = 0;
    int cur   = start;
    int prev  = -1;

    do {
        if (count >= maxPairs) break;
        outXY[count * 2]     = (float)(cur % cw);
        outXY[count * 2 + 1] = (float)(cur / cw);
        ++count;

        int next = -1;
        for (int k = 0; k < adj_n[cur]; ++k) {
            if (adj_c[cur][k] != prev) { next = adj_c[cur][k]; break; }
        }
        if (next < 0 || next == start) break;
        prev = cur;
        cur  = next;
    } while (true);

    return count;
}

// RDP SIMPLIFICATION
// may alias inXY — copy is safe because of in-order write
// epsilon = max deviation in pixels

static float perpDist2(
    float px, float py,
    float ax, float ay,
    float bx, float by
) {
    const float dx = bx - ax, dy = by - ay;
    const float len2 = dx*dx + dy*dy;
    if (len2 == 0.0f) {
        const float ex = px - ax, ey = py - ay;
        return ex*ex + ey*ey;
    }
    const float t = ((px - ax)*dx + (py - ay)*dy) / len2;
    const float qx = ax + t*dx - px;
    const float qy = ay + t*dy - py;
    return qx*qx + qy*qy;
}

// KEEP THIS ITERATIVE or it blows call stack on large inputs

EMSCRIPTEN_KEEPALIVE
int simplifyRDP(
    const float* inXY, int inCount,
    float* outXY, float epsilon
) {
    if (inCount <= 2) {
        memcpy(outXY, inXY, inCount * 2 * sizeof(float));
        return inCount;
    }

    std::vector<int> keep(inCount, 0);
    keep[0] = keep[inCount - 1] = 1;

    const float eps2 = epsilon * epsilon;
    std::vector<std::pair<int,int>> work;
    work.reserve(64);
    work.push_back({0, inCount - 1});

    while (!work.empty()) {
        auto [lo, hi] = work.back();
        work.pop_back();
        if (hi <= lo + 1) continue;

        const float ax = inXY[lo * 2], ay = inXY[lo * 2 + 1];
        const float bx = inXY[hi * 2], by = inXY[hi * 2 + 1];
        float maxD = 0; int maxI = lo;
        for (int i = lo + 1; i < hi; ++i) {
            const float d = perpDist2(inXY[i*2], inXY[i*2+1], ax, ay, bx, by);
            if (d > maxD) { maxD = d; maxI = i; }
        }
        if (maxD > eps2) {
            keep[maxI] = 1;
            work.push_back({lo, maxI});
            work.push_back({maxI, hi});
        }
    }

    int out = 0;
    for (int i = 0; i < inCount; ++i) {
        if (keep[i]) {
            outXY[out * 2]     = inXY[i * 2];
            outXY[out * 2 + 1] = inXY[i * 2 + 1];
            ++out;
        }
    }
    return out;
}

} // extern "C"
