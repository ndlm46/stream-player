/* ============================================
   YT Stream Player — App Logic
   ============================================ */

(function () {
    'use strict';

    // ---- DOM Elements ----
    const searchInput = document.getElementById('searchInput');
    const searchBtn = document.getElementById('searchBtn');
    const welcomeSection = document.getElementById('welcomeSection');
    const searchResults = document.getElementById('searchResults');
    const resultsTitle = document.getElementById('resultsTitle');
    const resultsGrid = document.getElementById('resultsGrid');
    const loadingState = document.getElementById('loadingState');
    const loadingText = document.getElementById('loadingText');

    // Player
    const playerBar = document.getElementById('playerBar');
    const playerThumb = document.getElementById('playerThumb');
    const playerThumbPulse = document.getElementById('playerThumbPulse');
    const playerTitle = document.getElementById('playerTitle');
    const playerArtist = document.getElementById('playerArtist');
    const playerTime = document.getElementById('playerTime');
    const playerBadge = document.getElementById('playerBadge');
    const playBtn = document.getElementById('playBtn');
    const prevBtn = document.getElementById('prevBtn');
    const nextBtn = document.getElementById('nextBtn');
    const volumeBtn = document.getElementById('volumeBtn');
    const volumeSlider = document.getElementById('volumeSlider');
    const progressFill = document.getElementById('playerProgressFill');
    const progressInput = document.getElementById('playerProgressInput');
    const audioPlayer = document.getElementById('audioPlayer');

    // Stream mode toggle
    const modeProxy = document.getElementById('modeProxy');
    const modeDirect = document.getElementById('modeDirect');

    const iconPlay = playBtn.querySelector('.icon-play');
    const iconPause = playBtn.querySelector('.icon-pause');
    const iconVol = volumeBtn.querySelector('.icon-vol');
    const iconMute = volumeBtn.querySelector('.icon-mute');

    // ---- State ----
    let playlist = [];
    let currentIndex = -1;
    let isPlaying = false;
    let isMuted = false;
    let previousVolume = 80;
    let streamMode = localStorage.getItem('streamMode') || 'proxy'; // 'proxy' or 'direct'
    let usingDirect = false; // true when the current src is the raw googlevideo URL
    let lastStreamData = null; // cache last /api/stream response for mode switching

    // Initialize toggle UI from saved preference
    function initStreamMode() {
        if (streamMode === 'direct') {
            modeProxy.classList.remove('active');
            modeDirect.classList.add('active');
        } else {
            modeProxy.classList.add('active');
            modeDirect.classList.remove('active');
        }
    }
    initStreamMode();

    // ---- Utility Functions ----
    function extractVideoId(input) {
        input = input.trim();
        // Direct video ID (11 chars)
        if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

        // YouTube URL patterns
        const patterns = [
            /(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/v\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
            /^.*(?:youtube\.com|youtu\.be).*[?&]v=([a-zA-Z0-9_-]{11})/,
        ];
        for (const p of patterns) {
            const m = input.match(p);
            if (m) return m[1];
        }
        return null;
    }

    function formatTime(seconds) {
        if (!seconds || isNaN(seconds)) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function showSection(section) {
        welcomeSection.classList.add('hidden');
        searchResults.classList.add('hidden');
        loadingState.classList.add('hidden');
        if (section) section.classList.remove('hidden');
    }

    // Toast notifications
    let toastEl = null;
    let toastTimeout = null;
    function showToast(message, type = 'error') {
        // Skip success toasts on mobile
        if (type === 'success' && window.innerWidth <= 768) return;

        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.className = 'toast';
            document.body.appendChild(toastEl);
        }
        clearTimeout(toastTimeout);
        toastEl.textContent = message;
        toastEl.className = `toast ${type}`;
        requestAnimationFrame(() => toastEl.classList.add('show'));
        toastTimeout = setTimeout(() => toastEl.classList.remove('show'), 4000);
    }

    // ---- Search ----
    async function performSearch(query) {
        const videoId = extractVideoId(query);
        if (videoId) {
            // Direct play
            await playVideo(videoId);
            return;
        }

        showSection(loadingState);
        loadingText.textContent = 'Đang tìm kiếm...';

        try {
            const resp = await fetch(`api/search?q=${encodeURIComponent(query)}`);
            if (!resp.ok) throw new Error('Search failed');
            const data = await resp.json();

            if (!data.results || data.results.length === 0) {
                showToast('Không tìm thấy kết quả nào');
                showSection(welcomeSection);
                return;
            }

            playlist = data.results;
            resultsTitle.textContent = `Kết quả cho "${query}"`;
            renderResults(data.results);
            showSection(searchResults);
        } catch (error) {
            console.error('Search error:', error);
            showToast('Lỗi tìm kiếm: ' + error.message);
            showSection(welcomeSection);
        }
    }

    function renderResults(results) {
        resultsGrid.innerHTML = '';
        results.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'result-card';
            card.style.animationDelay = `${index * 0.05}s`;
            card.innerHTML = `
                <div class="result-thumb-wrapper">
                    <img class="result-thumb" src="${item.thumbnail}" alt="${escapeHtml(item.title)}" loading="lazy">
                    ${item.duration ? `<span class="result-duration">${item.duration}</span>` : ''}
                    <div class="result-play-overlay">
                        <div class="result-play-icon">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                                <polygon points="8,5 19,12 8,19"/>
                            </svg>
                        </div>
                    </div>
                </div>
                <div class="result-info">
                    <div class="result-title">${escapeHtml(item.title)}</div>
                    <div class="result-meta">
                        <span class="result-author">${escapeHtml(item.author)}</span>
                        ${item.views ? `<span>• ${item.views}</span>` : ''}
                    </div>
                </div>
            `;
            card.addEventListener('click', () => {
                currentIndex = index;
                playVideo(item.videoId);
            });
            resultsGrid.appendChild(card);
        });
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    // ---- Player ----
    async function playVideo(videoId) {
        // Don't switch sections — keep current page visible
        // Only show loading if nothing is visible yet
        const anyVisible = !welcomeSection.classList.contains('hidden') || !searchResults.classList.contains('hidden');
        if (!anyVisible) {
            showSection(loadingState);
            loadingText.textContent = 'Đang tải stream...';
        }

        try {
            const resp = await fetch(`/api/stream/${videoId}`);
            if (!resp.ok) {
                const errData = await resp.json().catch(() => ({}));
                throw new Error(errData.error || 'Failed to get stream');
            }
            const data = await resp.json();

            // Update player UI
            playerThumb.src = data.thumbnail;
            playerTitle.textContent = data.title;
            playerArtist.textContent = data.author;
            playerBadge.textContent = data.itag === 140 ? 'AAC 140' : `OPUS ${data.itag}`;

            // Direct = browser fetches googlevideo itself (no server bandwidth). Stream URLs are
            // bound to the server's IP, so this only works when browser and server share an IP;
            // otherwise the 'error' handler falls back to the proxy automatically.
            lastStreamData = data;
            usingDirect = streamMode === 'direct' && !!data.url;
            audioPlayer.src = usingDirect ? data.url : `/api/proxy-stream/${videoId}`;
            audioPlayer.volume = volumeSlider.value / 100;

            playerBar.classList.remove('hidden');

            // Restore loading state back to current page if we showed it
            if (!anyVisible) {
                loadingState.classList.add('hidden');
                welcomeSection.classList.remove('hidden');
            }

            try {
                await audioPlayer.play();
                setPlayState(true);
            } catch (playErr) {
                console.warn('Autoplay / Play prompt:', playErr);
                setPlayState(false);
            }

            // Update document title
            document.title = `${data.title} — YT Stream Player`;

            showToast(`Đang phát${usingDirect ? ' (Direct)' : ''}: ${data.title}`, 'success');
        } catch (error) {
            console.error('Play error:', error);
            showToast('Lỗi phát nhạc: ' + error.message);
            // Restore page on error
            if (!anyVisible) {
                loadingState.classList.add('hidden');
                welcomeSection.classList.remove('hidden');
            }
        }
    }

    function setPlayState(playing) {
        isPlaying = playing;
        iconPlay.classList.toggle('hidden', playing);
        iconPause.classList.toggle('hidden', !playing);
        playerThumbPulse.classList.toggle('active', playing);
    }

    function togglePlay() {
        if (!audioPlayer.src) return;
        if (isPlaying) {
            audioPlayer.pause();
            setPlayState(false);
        } else {
            audioPlayer.play().then(() => setPlayState(true)).catch(() => {});
        }
    }

    function playNext() {
        if (playlist.length === 0) return;
        currentIndex = (currentIndex + 1) % playlist.length;
        playVideo(playlist[currentIndex].videoId);
    }

    function playPrev() {
        if (playlist.length === 0) return;
        // If more than 3 seconds in, restart. Otherwise go to previous
        if (audioPlayer.currentTime > 3) {
            audioPlayer.currentTime = 0;
            return;
        }
        currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
        playVideo(playlist[currentIndex].videoId);
    }

    function toggleMute() {
        if (isMuted) {
            audioPlayer.volume = previousVolume / 100;
            volumeSlider.value = previousVolume;
            isMuted = false;
        } else {
            previousVolume = volumeSlider.value;
            audioPlayer.volume = 0;
            volumeSlider.value = 0;
            isMuted = true;
        }
        iconVol.classList.toggle('hidden', isMuted);
        iconMute.classList.toggle('hidden', !isMuted);
    }

    // ---- Event Listeners ----

    // Search
    searchBtn.addEventListener('click', () => {
        const q = searchInput.value.trim();
        if (q) performSearch(q);
    });

    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const q = searchInput.value.trim();
            if (q) performSearch(q);
        }
    });

    // Search icon / Clear toggle
    const searchIconBtn = document.getElementById('searchIconBtn');
    const iconSearch = searchIconBtn.querySelector('.icon-search');
    const iconClear = searchIconBtn.querySelector('.icon-clear');

    function updateSearchIcon() {
        const hasText = searchInput.value.length > 0;
        iconSearch.classList.toggle('hidden', hasText);
        iconClear.classList.toggle('hidden', !hasText);
    }

    searchInput.addEventListener('input', updateSearchIcon);

    searchIconBtn.addEventListener('click', () => {
        if (searchInput.value) {
            searchInput.value = '';
            updateSearchIcon();
            searchInput.focus();
        } else {
            searchInput.focus();
        }
    });

    // Player controls
    playBtn.addEventListener('click', togglePlay);
    nextBtn.addEventListener('click', playNext);
    prevBtn.addEventListener('click', playPrev);
    volumeBtn.addEventListener('click', toggleMute);

    // Stream mode toggle
    function setStreamMode(mode) {
        streamMode = mode;
        localStorage.setItem('streamMode', mode);
        modeProxy.classList.toggle('active', mode === 'proxy');
        modeDirect.classList.toggle('active', mode === 'direct');

        if (mode === 'direct') {
            showToast('Direct: phát thẳng từ YouTube CDN. Nếu CDN chặn sẽ tự chuyển sang Proxy.', 'info');
        } else {
            showToast('Đang sử dụng Proxy Stream tối ưu', 'success');
        }
    }

    modeProxy.addEventListener('click', () => setStreamMode('proxy'));
    modeDirect.addEventListener('click', () => setStreamMode('direct'));

    volumeSlider.addEventListener('input', () => {
        const vol = volumeSlider.value / 100;
        audioPlayer.volume = vol;
        isMuted = vol === 0;
        iconVol.classList.toggle('hidden', isMuted);
        iconMute.classList.toggle('hidden', !isMuted);
    });

    // Progress bar
    audioPlayer.addEventListener('timeupdate', () => {
        if (!audioPlayer.duration) return;
        const pct = (audioPlayer.currentTime / audioPlayer.duration) * 100;
        progressFill.style.width = pct + '%';
        progressInput.value = pct;
        playerTime.textContent = `${formatTime(audioPlayer.currentTime)} / ${formatTime(audioPlayer.duration)}`;
    });

    progressInput.addEventListener('input', () => {
        if (!audioPlayer.duration) return;
        audioPlayer.currentTime = (progressInput.value / 100) * audioPlayer.duration;
    });

    audioPlayer.addEventListener('ended', () => {
        setPlayState(false);
        // Auto-play next if playlist
        if (playlist.length > 0) {
            playNext();
        }
    });

    let retryCount = 0;
    audioPlayer.addEventListener('error', () => {
        setPlayState(false);
        const err = audioPlayer.error;
        const errMsg = err ? `Code ${err.code}: ${err.message || 'Unknown'}` : 'Unknown error';
        console.error('Audio error:', errMsg);

        // Direct failed (usually CDN 403: URL is bound to the server IP) -> switch to proxy, keep position
        if (usingDirect && lastStreamData?.videoId) {
            usingDirect = false;
            const resumeAt = audioPlayer.currentTime || 0;
            showToast('YouTube CDN chặn phát Direct (link gắn với IP server) — chuyển sang Proxy.', 'info');
            audioPlayer.src = `/api/proxy-stream/${lastStreamData.videoId}`;
            audioPlayer.addEventListener('loadedmetadata', () => {
                if (resumeAt > 0) audioPlayer.currentTime = resumeAt;
            }, { once: true });
            audioPlayer.play().then(() => setPlayState(true)).catch(() => {});
            return;
        }
        
        // Auto-retry once (proxy-stream may have timed out)
        if (retryCount < 1 && currentIndex >= 0 && playlist[currentIndex]) {
            retryCount++;
            showToast('Stream lỗi, đang thử lại...', 'warning');
            setTimeout(() => playVideo(playlist[currentIndex].videoId), 1000);
        } else {
            retryCount = 0;
            showToast(`Lỗi phát audio: ${errMsg}`);
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Don't capture when typing in search
        if (document.activeElement === searchInput) return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                togglePlay();
                break;
            case 'ArrowLeft':
                if (audioPlayer.duration) audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime - 5);
                break;
            case 'ArrowRight':
                if (audioPlayer.duration) audioPlayer.currentTime = Math.min(audioPlayer.duration, audioPlayer.currentTime + 5);
                break;
            case 'ArrowUp':
                e.preventDefault();
                volumeSlider.value = Math.min(100, parseInt(volumeSlider.value) + 5);
                audioPlayer.volume = volumeSlider.value / 100;
                break;
            case 'ArrowDown':
                e.preventDefault();
                volumeSlider.value = Math.max(0, parseInt(volumeSlider.value) - 5);
                audioPlayer.volume = volumeSlider.value / 100;
                break;
            case 'KeyM':
                toggleMute();
                break;
        }
    });

    // Focus search on /
    document.addEventListener('keydown', (e) => {
        if (e.key === '/' && document.activeElement !== searchInput) {
            e.preventDefault();
            searchInput.focus();
        }
    });

    // ---- Trending / Suggestions ----
    const trendingGrid = document.getElementById('trendingGrid');
    const trendingLoading = document.getElementById('trendingLoading');

    function renderResultsTo(targetGrid, results, setAsPlaylist = false) {
        targetGrid.innerHTML = '';
        results.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'result-card';
            card.style.animationDelay = `${index * 0.05}s`;
            card.innerHTML = `
                <div class="result-thumb-wrapper">
                    <img class="result-thumb" src="${item.thumbnail}" alt="${escapeHtml(item.title)}" loading="lazy">
                    ${item.duration ? `<span class="result-duration">${item.duration}</span>` : ''}
                    <div class="result-play-overlay">
                        <div class="result-play-icon">
                            <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                                <polygon points="8,5 19,12 8,19"/>
                            </svg>
                        </div>
                    </div>
                </div>
                <div class="result-info">
                    <div class="result-title">${escapeHtml(item.title)}</div>
                    <div class="result-meta">
                        <span class="result-author">${escapeHtml(item.author)}</span>
                        ${item.views ? `<span>• ${item.views}</span>` : ''}
                    </div>
                </div>
            `;
            card.addEventListener('click', () => {
                if (setAsPlaylist) {
                    playlist = results;
                }
                currentIndex = index;
                playVideo(item.videoId);
            });
            targetGrid.appendChild(card);
        });
    }

    async function loadTrending() {
        if (!trendingGrid || !trendingLoading) return;
        trendingLoading.style.display = 'flex';
        trendingGrid.innerHTML = '';

        try {
            const resp = await fetch('api/trending');
            if (!resp.ok) throw new Error('Failed to load trending');
            const data = await resp.json();

            if (data.results && data.results.length > 0) {
                renderResultsTo(trendingGrid, data.results, true);
                // Set as default playlist if none set
                if (playlist.length === 0) {
                    playlist = data.results;
                }
            }
        } catch (error) {
            console.error('Trending error:', error);
            trendingGrid.innerHTML = '<p style="color: var(--text-muted); text-align: center; padding: 20px;">Không thể tải gợi ý</p>';
        } finally {
            trendingLoading.style.display = 'none';
        }
    }

    // Load trending on page init
    loadTrending();

})();
