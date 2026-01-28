const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 4000;

// [최적화] 전역 브라우저 변수 (하나로 돌려쓰기)
let globalBrowser = null;

async function getBrowser() {
    // 브라우저가 없거나 죽었으면 새로 실행
    if (!globalBrowser || !globalBrowser.isConnected()) {
        console.log('🚀 Chrome 인스턴스 시작 (무한 재사용 모드)...');
        globalBrowser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--window-size=1920,1080',
                // 저사양 PC 최적화 옵션
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--no-first-run',
                '--no-zygote'
            ]
        });
    }
    return globalBrowser;
}

app.post('/scrape', async (req, res) => {
    const { nickname, serverId = 1006 } = req.body;
    console.log(`[요청] ${nickname} (서버: ${serverId}) 검색 시작...`);

    let page = null;
    let attempts = 0;
    const MAX_ATTEMPTS = 2; // 최대 2번 시도

    while (attempts < MAX_ATTEMPTS) {
        attempts++;
        if (attempts > 1) console.log(`🔄 [재시도] ${nickname} (시도 ${attempts}/${MAX_ATTEMPTS})`);

        try {
            // [최적화] 브라우저를 매번 켜는게 아니라, 탭만 새로 엽니다. (훨씬 빠르고 가벼움)
            const browser = await getBrowser();
            page = await browser.newPage();

            await page.setViewport({ width: 1920, height: 1080 });

            // 리소스 차단 (이미지, 폰트 등 불필요한 로딩 막기 - 속도 향상)
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const resourceType = req.resourceType();
                if (['image', 'media', 'font', 'stylesheet'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.goto('https://aion2tool.com', { waitUntil: 'domcontentloaded' });

            // 2. 종족 선택
            try {
                await page.waitForSelector('#race-elyos', { timeout: 3000 }); // 타임아웃 5초 -> 3초 (빠른 실패)
                await page.click('#race-elyos');
            } catch (e) { }

            // 3. 서버 선택
            try {
                await page.waitForSelector('#server-select', { timeout: 3000 });
                await page.select('#server-select', String(serverId));
            } catch (e) { }

            // 4. 입력 & 엔터
            const inputSelector = 'input[placeholder="캐릭터 닉네임 입력"]';
            await page.waitForSelector(inputSelector);

            await page.type(inputSelector, nickname);
            await new Promise(r => setTimeout(r, 300));
            await page.keyboard.press('Enter');

            // 5. 로딩 (대기 로직 유지하되 타임아웃 45초로 연장 - 똥컴 배려)
            try {
                await page.waitForFunction(
                    () => {
                        const powerEl = document.querySelector('#result-combat-power');
                        const scoreEl = document.querySelector('#dps-score-value');
                        const notFound = document.body.innerText.includes("검색어에 해당하는");

                        if (notFound) return true;

                        const hasPower = powerEl && /\d/.test(powerEl.innerText);
                        const hasScore = scoreEl && /\d/.test(scoreEl.innerText);

                        if (hasPower && hasScore) return true;
                        return false;
                    },
                    { timeout: 45000 }
                );
            } catch (e) {
                console.log("⚠️ 로딩 타임아웃 (부분 데이터만 있을 수 있음)");
            }

            // 데이터 추출
            const data = await page.evaluate(() => {
                const bodyText = document.body.innerText;
                const powerEl = document.getElementById('result-combat-power');
                const scoreEl = document.getElementById('dps-score-value');

                return {
                    raw: bodyText,
                    lines: bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0),
                    idPower: powerEl ? powerEl.innerText : null,
                    idScore: scoreEl ? scoreEl.innerText : null
                };
            });

            const raw = data.raw;
            const lines = data.lines;

            if (raw.includes("검색어에 해당하는 캐릭터가 없습니다")) {
                if (page) await page.close();
                return res.json({ success: false, error: "CHARACTER_NOT_FOUND" });
            }

            const jobs = ["수호성", "검성", "살성", "궁성", "마도성", "정령성", "치유성", "호법성"];
            const job = jobs.find(j => raw.includes(j)) || "미정";

            // Power Parsing
            let power = 0;
            if (data.idPower) {
                power = parseInt(data.idPower.replace(/[^0-9]/g, '')) || 0;
            }
            if (power === 0) {
                const powerMatch = raw.match(/전투력\s*([\d,]+)/);
                if (powerMatch) power = parseInt(powerMatch[1].replace(/,/g, ''));
            }

            let guild = "-";
            const legionLine = lines.find(l => l.includes('레기온') && !l.includes('전체') && !l.includes('필터') && !l.includes('랭킹'));
            if (legionLine) {
                const match = legionLine.match(/([^\s]+)\s*레기온/);
                if (match && match[1] !== '프') guild = match[1];
                else {
                    const match2 = legionLine.match(/레기온\s*[:]?\s*([^\s]+)/);
                    if (match2) guild = match2[1];
                }
            }
            if (guild === "-" || guild === "프") {
                const chuLine = lines.find(l => l === "츄" || l === "츄 레기온");
                if (chuLine) guild = "츄";
            }
            if (guild === "랭킹") guild = "-";

            // Score Parsing
            let score = 0;
            if (data.idScore) {
                score = parseInt(data.idScore.replace(/[^0-9]/g, '')) || 0;
            }
            if (score === 0) {
                const scoreMatch = raw.match(/(Score|점수|RP|어비스 포인트)\s*[:]?\s*([\d,]+)/i);
                if (scoreMatch) score = parseInt(scoreMatch[2].replace(/,/g, ''));
            }

            // Retry Condition: Power exists but Score is 0
            if (power > 0 && score === 0) {
                console.log(`⚠️ 불완전 데이터 감지 (Power: ${power}, Score: ${score}). 재시도...`);
                if (page) await page.close();
                continue; // Retry loop
            }

            if (power === 0) throw new Error("INVALID_DATA (Power is 0)");

            console.log(`[성공] ${nickname} -> ${job} / ${power} / ${guild} / ${score}`);
            if (page) await page.close();
            return res.json({ success: true, data: { name: nickname, class: job, power: power, guild: guild, score: score } });

        } catch (e) {
            console.error(`[실패] ${nickname}: ${e.message}`);
            if (page) await page.close();

            // Last attempt failed
            if (attempts === MAX_ATTEMPTS) {
                return res.json({ success: false, error: e.message });
            }
            // Otherwise loop continues
        }
    }
});

app.listen(PORT, () => {
    console.log(`Optimized Server running on port ${PORT}`);
});
