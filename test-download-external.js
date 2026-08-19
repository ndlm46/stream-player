// Stress test: Mô phỏng N client cùng nghe 1 bài qua proxy
// So sánh: không cache (trước) vs có cache (sau)

const CONCURRENT_CLIENTS = 20;
const VIDEO_ID = 'JGwWNGJdvx8'; // Shape of You
const PROXY_URL = `http://localhost:3210/api/proxy-stream/${VIDEO_ID}`;

async function simulateClient(id) {
    const start = Date.now();
    try {
        const res = await fetch(PROXY_URL);
        if (!res.ok) {
            return { id, status: res.status, ok: false, ms: Date.now() - start };
        }

        // Read first 3 chunks only (enough to confirm streaming works)
        const reader = res.body.getReader();
        let bytes = 0;
        for (let i = 0; i < 3; i++) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.length;
        }
        reader.cancel();

        return { id, status: res.status, ok: true, bytes, ms: Date.now() - start };
    } catch (e) {
        return { id, status: 0, ok: false, error: e.message, ms: Date.now() - start };
    }
}

async function runStressTest() {
    console.log(`\n🔥 Stress Test: ${CONCURRENT_CLIENTS} client cùng nghe "${VIDEO_ID}"\n`);
    console.log('Đang gửi tất cả request đồng thời...\n');

    const globalStart = Date.now();

    // Fire all requests at the same time
    const promises = [];
    for (let i = 0; i < CONCURRENT_CLIENTS; i++) {
        promises.push(simulateClient(i + 1));
    }

    const results = await Promise.all(promises);
    const totalMs = Date.now() - globalStart;

    // Summary
    const ok = results.filter(r => r.ok);
    const fail = results.filter(r => !r.ok);
    const times = ok.map(r => r.ms);
    const avgMs = times.length ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(0) : 0;
    const maxMs = times.length ? Math.max(...times) : 0;
    const minMs = times.length ? Math.min(...times) : 0;

    console.log('━━━━━━━━━━━ Kết quả ━━━━━━━━━━━');
    console.log(`✅ Thành công: ${ok.length}/${CONCURRENT_CLIENTS}`);
    console.log(`❌ Thất bại:   ${fail.length}/${CONCURRENT_CLIENTS}`);
    console.log(`⏱  Thời gian tổng: ${totalMs}ms`);
    console.log(`⏱  Phản hồi TB:    ${avgMs}ms`);
    console.log(`⏱  Nhanh nhất:     ${minMs}ms`);
    console.log(`⏱  Chậm nhất:      ${maxMs}ms`);

    if (fail.length > 0) {
        console.log('\nChi tiết lỗi:');
        fail.forEach(r => console.log(`  Client #${r.id}: ${r.status} ${r.error || ''}`));
    }

    // Check stats endpoint
    try {
        const stats = await (await fetch('http://localhost:3210/api/stats')).json();
        console.log('\n📊 Server Stats:');
        console.log(`  Stream URL Cache:   ${stats.streamUrlCache} entries`);
        console.log(`  Metadata Cache:     ${stats.metaCache} entries`);
        console.log(`  Pending Resolves:   ${stats.pendingResolves}`);
        console.log(`  PoToken Active:     ${stats.poTokenActive}`);
        console.log(`  Innertube Ready:    ${stats.innertubeReady}`);
    } catch (e) { /* ignore */ }
}

runStressTest();
