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
// Moore neighbourhood. Returns point pairs written.
// Stops when the first move (start -> second pixel) is about to repeat. The simpler "back at the
// start pixel" test can stop early or never stop on 1px spurs and borders drawn as thin lines.

static const int MX[8] = { 1, 1, 0,-1,-1,-1, 0, 1 };
static const int MY[8] = { 0,-1,-1,-1, 0, 1, 1, 1 };

static int dirOf(int dx, int dy) {
    for (int d = 0; d < 8; ++d)
        if (MX[d] == dx && MY[d] == dy) return d;
    return 0;
}

EMSCRIPTEN_KEEPALIVE
int traceBoundary(
    const uint8_t* mask, int width, int height,
    float* outXY, int maxPairs
) {
    // topmost-leftmost filled pixel: its west neighbour is outside the mask
    int startX = -1, startY = -1;
    for (int y = 0; y < height && startX < 0; ++y)
        for (int x = 0; x < width && startX < 0; ++x)
            if (mask[y * width + x]) { startX = x; startY = y; }

    if (startX < 0) return 0;

    auto filled = [&](int x, int y) {
        return x >= 0 && x < width && y >= 0 && y < height && mask[y * width + x];
    };

    int cx = startX, cy = startY;
    int back = 4;                 // direction from the current pixel to the last outside pixel seen
    int secondX = -1, secondY = -1;
    int count = 0;

    while (count < maxPairs) {
        // turn clockwise (decreasing index on screen) from the backtrack to the next filled pixel
        int d = -1;
        for (int i = 1; i <= 8; ++i) {
            int k = ((back - i) % 8 + 8) % 8;
            if (filled(cx + MX[k], cy + MY[k])) { d = k; break; }
        }
        if (d < 0) {              // lone pixel
            outXY[0] = (float)cx;
            outXY[1] = (float)cy;
            return 1;
        }
        int nx = cx + MX[d], ny = cy + MY[d];
        if (cx == startX && cy == startY && nx == secondX && ny == secondY) break;
        if (secondX < 0) { secondX = nx; secondY = ny; }

        outXY[count * 2]     = (float)cx;
        outXY[count * 2 + 1] = (float)cy;
        ++count;

        // the outside neighbour checked just before the hit becomes the new backtrack
        int pd = (d + 1) % 8;
        int bx = cx + MX[pd], by = cy + MY[pd];
        cx = nx; cy = ny;
        back = dirOf(bx - cx, by - cy);
    }
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
