const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

const PORT = 4000;

let browser = null;

async function initBrowser() {
    if (!browser) {
        console.log('🚀 Chrome 실행 중...');
        // [중요] headless: "new"로 설정 (서브컴 배포용)
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
    }
    return browser;
}

app.post('/scrape', async (req, res) => {
    // serverId 기본값 1006 (아리엘)
    const { nickname, serverId = 1006 } = req.body;
    console.log(`[요청] ${nickname} (서버: ${serverId}) 검색 시작...`);

    let page = null;
    try {
        const browser = await initBrowser();
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        // 1. 메인 페이지 접속
        await page.goto('https://aion2tool.com', { waitUntil: 'networkidle2' });

        // 2. 종족 선택 (천족: #race-elyos / 마족: #race-asmodian) - 일단 천족 기본 설정
        try {
            await page.waitForSelector('#race-elyos', { timeout: 3000 });
            await page.click('#race-elyos');
        } catch (e) {
            console.log("⚠️ 종족 선택 실패 (기본값 사용)");
        }

        // 3. 서버 선택
        try {
            await page.waitForSelector('#server-select', { timeout: 3000 });
            await page.select('#server-select', String(serverId));
        } catch (e) {
            console.log("⚠️ 서버 선택 실패 (기본값 사용)");
        }

        // 4. 닉네임 입력 및 엔터
        const inputSelector = 'input[placeholder="캐릭터 닉네임 입력"]';
        // 입력창이 렌더링될 때까지 대기
        await page.waitForSelector(inputSelector, { timeout: 5000 });

        await page.type(inputSelector, nickname);
        await new Promise(r => setTimeout(r, 200)); // 입력 딜레이
        await page.keyboard.press('Enter');

        // 5. 로딩 대기 (프로필 페이지 진입 체크)
        // "종합 능력치"나 "전투력"이 뜰 때까지 대기
        try {
            await page.waitForFunction(
                () => document.body.innerText.includes("종합 능력치") ||
                    document.body.innerText.includes("전투력"),
                { timeout: 15000 }
            );
        } catch (e) {
            // 검색 실패 시 체크
            const isNotFound = await page.evaluate(() => document.body.innerText.includes("검색어에 해당하는"));
            if (isNotFound) {
                throw new Error("CHARACTER_NOT_FOUND");
            }
            throw new Error("PROFILE_LOAD_TIMEOUT");
        }

        // 6. 데이터 추출
        const data = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return {
                raw: bodyText,
                lines: bodyText.split('\n').map(l => l.trim()).filter(l => l.length > 0)
            };
        });

        const raw = data.raw;
        const lines = data.lines;

        // --- 파싱 로직 ---
        const jobs = ["수호성", "검성", "살성", "궁성", "마도성", "정령성", "치유성", "호법성"];
        const job = jobs.find(j => raw.includes(j)) || "미정";

        let power = 0;
        const powerMatch = raw.match(/전투력\s*([\d,]+)/);
        if (powerMatch) power = parseInt(powerMatch[1].replace(/,/g, ''));

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

        let score = 0;
        const scoreMatch = raw.match(/(Score|점수|RP|어비스 포인트)\s*[:]?\s*([\d,]+)/i);
        if (scoreMatch) score = parseInt(scoreMatch[2].replace(/,/g, ''));

        // 유효성 재검사 (전투력이 0이면 로딩 실패로 간주)
        if (power === 0) throw new Error("INVALID_DATA (Power is 0)");

        console.log(`[성공] ${nickname} -> ${job} / ${power} / ${guild} / ${score}`);

        res.json({ success: true, data: { name: nickname, class: job, power: power, guild: guild, score: score } });

    } catch (e) {
        console.error(`[실패] ${nickname}: ${e.message}`);
        res.json({ success: false, error: e.message });
    } finally {
        if (page) await page.close();
    }
});

app.listen(PORT, () => {
    console.log(`Example app listening on port ${PORT}`);
    console.log(`서버 주소: http://localhost:${PORT}`);
});
