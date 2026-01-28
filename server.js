const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 4000;

let browser = null;

async function initBrowser() {
    console.log('🚀 Chrome 실행 준비 (Headless Mode + 1080p 고정)...');
    return await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1920,1080'
        ]
    });
}

app.post('/scrape', async (req, res) => {
    const { nickname, serverId = 1006 } = req.body;
    console.log(`[요청] ${nickname} (서버: ${serverId}) 검색 시작...`);

    let page = null;
    let localBrowser = null;

    try {
        localBrowser = await initBrowser();
        page = await localBrowser.newPage();

        await page.setViewport({ width: 1920, height: 1080 });

        await page.goto('https://aion2tool.com', { waitUntil: 'networkidle2' });

        // 2. 종족 선택
        try {
            await page.waitForSelector('#race-elyos', { timeout: 3000 });
            await page.click('#race-elyos');
        } catch (e) {
            console.log("⚠️ 종족 선택 실패");
        }

        // 3. 서버 선택
        try {
            await page.waitForSelector('#server-select', { timeout: 3000 });
            await page.select('#server-select', String(serverId));
        } catch (e) {
            console.log("⚠️ 서버 선택 실패");
        }

        // 4. 입력 & 엔터
        const inputSelector = 'input[placeholder="캐릭터 닉네임 입력"]';
        await page.waitForSelector(inputSelector);

        await page.type(inputSelector, nickname);
        await new Promise(r => setTimeout(r, 500));
        await page.keyboard.press('Enter');

        // 5. 로딩 (대기 로직 강화)
        try {
            console.log("⏳ 데이터 로딩 대기 중...");
            await page.waitForFunction(
                () => {
                    const powerEl = document.querySelector('#result-combat-power');
                    const scoreEl = document.querySelector('#dps-score-value');
                    const notFound = document.body.innerText.includes("검색어에 해당하는");

                    if (notFound) return true;

                    // [핵심 수정] 둘 다 "숫자"가 포함되어 있어야 완료로 간주
                    const hasPower = powerEl && /\d/.test(powerEl.innerText);
                    const hasScore = scoreEl && /\d/.test(scoreEl.innerText);

                    // 전투력은 필수, 점수는 있으면 좋음 (하지만 전투력이 떴으면 보통 점수도 곧 뜸)
                    // 안전하게 둘 다 뜰 때까지 기다림 (최대 30초)
                    if (hasPower && hasScore) return true;

                    return false;
                },
                { timeout: 30000 }
            );
        } catch (e) {
            console.log("⚠️ 로딩 타임아웃 (부분 데이터만 있을 수 있음)");
        }

        // 약간의 안정화 대기
        await new Promise(r => setTimeout(r, 1000));

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
            throw new Error("CHARACTER_NOT_FOUND");
        }

        const jobs = ["수호성", "검성", "살성", "궁성", "마도성", "정령성", "치유성", "호법성"];
        const job = jobs.find(j => raw.includes(j)) || "미정";

        // 1. 전투력 Parsing (숫자만 남기기)
        let power = 0;
        if (data.idPower) {
            // [수정] 콤마 외에도 공백 등 모든 문자 제거 후 파싱
            const cleanStr = data.idPower.replace(/[^0-9]/g, '');
            power = parseInt(cleanStr) || 0;
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

        // 2. 점수 Parsing (숫자만 남기기)
        let score = 0;
        if (data.idScore) {
            // [수정] 동일하게 숫자만 남기고 파싱, 실패 시 0
            const cleanStr = data.idScore.replace(/[^0-9]/g, '');
            score = parseInt(cleanStr) || 0;
        }
        if (score === 0) {
            const scoreMatch = raw.match(/(Score|점수|RP|어비스 포인트)\s*[:]?\s*([\d,]+)/i);
            if (scoreMatch) score = parseInt(scoreMatch[2].replace(/,/g, ''));
        }

        if (power === 0) throw new Error("INVALID_DATA (Power is 0)");

        console.log(`[성공] ${nickname} -> ${job} / ${power} / ${guild} / ${score}`);

        res.json({ success: true, data: { name: nickname, class: job, power: power, guild: guild, score: score } });

    } catch (e) {
        console.error(`[실패] ${nickname}: ${e.message}`);
        res.json({ success: false, error: e.message });
    } finally {
        if (localBrowser) await localBrowser.close();
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
