#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <vector>
#include <algorithm>
#include <emscripten.h>

extern "C" {

// MEMORY

EMSCRIPTEN_KEEPALIVE void* wasmAlloc(int bytes) { return malloc(bytes); }
EMSCRIPTEN_KEEPALIVE void  wasmFree(void* ptr)  { free(ptr); }

// FLOOD FILL
// Iterative BFS, 4-connectivity. Returns number of pixels filled.

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

// CONTOUR TRACE
// Moore neighbourhood, Jacob's stopping criterion. Returns point pairs written.

static const int MX[8] = { 1, 1, 0,-1,-1,-1, 0, 1 };
static const int MY[8] = { 0,-1,-1,-1, 0, 1, 1, 1 };

EMSCRIPTEN_KEEPALIVE
int traceBoundary(
    const uint8_t* mask, int width, int height,
    float* outXY, int maxPairs
) {
    // find topmost-leftmost filled pixel
    int startX = -1, startY = -1;
    for (int y = 0; y < height && startX < 0; ++y)
        for (int x = 0; x < width && startX < 0; ++x)
            if (mask[y * width + x]) { startX = x; startY = y; }

    if (startX < 0) return 0;

    // single pixel — check if truly isolated
    if (mask[startY * width + startX]) {
        outXY[0] = (float)startX;
        outXY[1] = (float)startY;
        bool lone = true;
        for (int d = 0; d < 8 && lone; ++d) {
            int nx = startX + MX[d], ny = startY + MY[d];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx])
                lone = false;
        }
        if (lone) return 1;
    }

    int cx = startX, cy = startY;
    int prevDir = 6; // approach from left; backtrack = right
    int count = 0;
    bool first = true;

    do {
        if (count >= maxPairs) break;
        outXY[count * 2]     = (float)cx;
        outXY[count * 2 + 1] = (float)cy;
        ++count;

        int searchStart = (prevDir + 5) % 8;
        bool found = false;
        for (int i = 0; i < 8; ++i) {
            int d = (searchStart + i) % 8;
            int nx = cx + MX[d], ny = cy + MY[d];
            if (nx >= 0 && nx < width && ny >= 0 && ny < height && mask[ny * width + nx]) {
                prevDir = (d + 4) % 8;
                cx = nx; cy = ny;
                found = true;
                break;
            }
        }
        if (!found) break;
        first = false;
    } while (first || cx != startX || cy != startY);

    return count;
}

// RDP SIMPLIFY
// Returns number of point pairs in output.

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

static void rdpMark(const float* pts, int* keep, int lo, int hi, float eps2) {
    if (hi <= lo + 1) return;
    const float ax = pts[lo*2], ay = pts[lo*2+1];
    const float bx = pts[hi*2], by = pts[hi*2+1];
    float maxD = 0; int maxI = lo;
    for (int i = lo + 1; i < hi; ++i) {
        float d = perpDist2(pts[i*2], pts[i*2+1], ax, ay, bx, by);
        if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps2) {
        keep[maxI] = 1;
        rdpMark(pts, keep, lo, maxI, eps2);
        rdpMark(pts, keep, maxI, hi, eps2);
    }
}

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
    rdpMark(inXY, keep.data(), 0, inCount - 1, epsilon * epsilon);

    int out = 0;
    for (int i = 0; i < inCount; ++i) {
        if (keep[i]) {
            outXY[out*2]   = inXY[i*2];
            outXY[out*2+1] = inXY[i*2+1];
            ++out;
        }
    }
    return out;
}

} // extern "C"
