// ==UserScript==
// @name         Sapo POS - Agent theo target (v22.8)
// @namespace    http://tampermonkey.net/
// @version      22.8.0
// @description  Lập giỏ tự nhiên theo target, mỗi mã dưới 5 món, kiểm tra lại trước khi thanh toán.
// @author       You
// @match        *://*.mysapo.net/admin/pos*
// @match        *://*.mysapo.vn/admin/pos*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/* jshint esversion: 11 */

(function () {
    'use strict';

    const VERSION = '22.8.0';
    const STORAGE = {
        running: 'sapo_is_running_v22',
        queue: 'sapo_auto_queue_v22',
        products: 'sapo_pos_products_cache_v22',
        history: 'sapo_auto_history_v22'
    };
    const CFG = {
        // Quy tắc planning: mọi dòng hàng phải có quantity 1..4 (luôn dưới 5).
        maxQty: 4,
        maxTarget: 5000000,
        maxQueue: 100,
        maxScaledTarget: 200000,
        cacheMs: 30 * 60 * 1000,
        pageSize: 250,
        maxPages: 50,
        selectAttempts: 3,
        candidatesPerAttempt: 140,
        plannerBudgetMs: 1600,
        plannerMaxWrites: 240000,
        waitSuggestionMs: 8000,
        waitCartMs: 9000,
        verifyTolerance: 0,
        autoCheckout: true
    };

    let loopBusy = false;
    let cachedCartTotalLabel = null;
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const yieldToBrowser = () => globalThis.scheduler?.yield ? globalThis.scheduler.yield() : sleep(0);
    const norm = value => String(value == null ? '' : value)
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/\s+/g, ' ').trim();

    function parseApiNumber(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
        if (value == null) return 0;
        const raw = String(value).trim();
        if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw) || 0;
        const cleaned = raw.replace(/[^\d-]/g, '');
        return Number(cleaned) || 0;
    }

    function parseVndText(value) {
        const groups = String(value == null ? '' : value).match(/\d[\d.,\s]*/g) || [];
        const nums = groups.map(x => Number(x.replace(/\D/g, '')) || 0).filter(Boolean);
        return nums.length ? nums[nums.length - 1] : 0;
    }

    function formatVnd(value) {
        return `${Math.round(value || 0).toLocaleString('vi-VN')}đ`;
    }

    function firstPositiveMoney(...values) {
        for (const value of values) {
            const number = Math.round(parseApiNumber(value));
            if (number > 0) return number;
        }
        return 0;
    }

    function readJson(key, fallback) {
        try { return JSON.parse(localStorage.getItem(key) || JSON.stringify(fallback)); }
        catch (_) { return fallback; }
    }
    function getQueue() { return readJson(STORAGE.queue, []); }
    function setQueue(queue) { localStorage.setItem(STORAGE.queue, JSON.stringify(queue)); }
    function isRunning() { return localStorage.getItem(STORAGE.running) === 'true'; }
    function setRunning(value) { localStorage.setItem(STORAGE.running, value ? 'true' : 'false'); }

    function sanitizeStoredQueue() {
        const raw = readJson(STORAGE.queue, []);
        if (!Array.isArray(raw)) {
            setQueue([]); setRunning(false);
            return 'Đã chặn hàng đợi bị hỏng.';
        }
        const valid = raw.slice(0, CFG.maxQueue).map(parseApiNumber)
            .map(Math.round)
            .filter(value => Number.isSafeInteger(value) && value > 0 && value <= CFG.maxTarget);
        const changed = valid.length !== raw.length || valid.some((value, index) => value !== raw[index]);
        if (changed) {
            setQueue(valid);
            setRunning(false);
            return `Đã loại target không an toàn. Agent đang tạm dừng; còn ${valid.length} target hợp lệ.`;
        }
        return '';
    }

    function updateStatus(message, isError = false) {
        const el = document.getElementById('sapoAutoStatus');
        if (el) {
            el.textContent = message;
            el.style.color = isError ? '#c62828' : '#455a64';
        }
        console[isError ? 'error' : 'log'](`[Sapo Agent] ${message}`);
    }

    function renderUI() {
        let panel = document.getElementById('sapo-auto-panel');
        if (!panel) {
            panel = document.createElement('div');
            panel.id = 'sapo-auto-panel';
            panel.style.cssText = 'position:fixed;bottom:20px;left:20px;z-index:2147483647;background:#fff;padding:14px;border-radius:9px;box-shadow:0 4px 22px #0004;border:2px solid #0783f2;font-family:Arial,sans-serif;width:270px';
            document.body.appendChild(panel);
        }
        const queue = getQueue();
        const running = isRunning();
        panel.innerHTML = `
            <div style="font-weight:700;text-align:center;color:#0783f2;margin-bottom:9px">SAPO POS AGENT v${VERSION}</div>
            ${queue.length ? `
                <div style="padding:7px;background:${running ? '#e8f5e9' : '#fff3e0'};border-radius:5px;font-size:12px;text-align:center;margin-bottom:8px">
                    ${running ? 'Đang chạy' : 'Đang tạm dừng'} · Còn ${queue.length} hóa đơn<br>
                    Target kế tiếp: <b>${formatVnd(queue[0])}</b>
                </div>
                <button id="sapoToggle" style="width:100%;padding:8px;border:0;border-radius:5px;color:#fff;background:${running ? '#ef6c00' : '#2e7d32'};font-weight:700">${running ? 'TẠM DỪNG' : 'TIẾP TỤC'}</button>
                <button id="sapoCancel" style="width:100%;padding:7px;margin-top:6px;border:0;border-radius:5px;color:#fff;background:#c62828;font-weight:700">HỦY DANH SÁCH</button>
            ` : `
                <label style="font-size:11px;font-weight:700;color:#555">Mỗi dòng là nghìn đồng (150 = 150.000đ)</label>
                <textarea id="sapoAmounts" rows="5" placeholder="150\n230\n75" style="box-sizing:border-box;width:100%;margin:5px 0 7px;padding:8px;border:1px solid #0783f2;border-radius:5px;resize:none"></textarea>
                <button id="sapoStart" style="width:100%;padding:9px;border:0;border-radius:5px;color:#fff;background:#0783f2;font-weight:700">CHẠY HÀNG LOẠT</button>
                <button id="sapoRefresh" style="width:100%;padding:6px;margin-top:6px;border:1px solid #aaa;border-radius:5px;background:#fff;font-size:11px">LÀM MỚI DỮ LIỆU SẢN PHẨM</button>
            `}
            <div id="sapoAutoStatus" style="margin-top:8px;font-size:11px;text-align:center;font-weight:700"></div>`;

        panel.querySelector('#sapoStart')?.addEventListener('click', () => {
            const amounts = panel.querySelector('#sapoAmounts').value.split(/\r?\n/)
                .map(x => parseApiNumber(x.replace(/[,\s]/g, '')))
                .filter(x => x > 0).map(x => Math.round(x * 1000));
            if (!amounts.length) return alert('Vui lòng nhập ít nhất một số tiền hợp lệ.');
            if (amounts.length > CFG.maxQueue) return alert(`Chỉ được chạy tối đa ${CFG.maxQueue} hóa đơn mỗi lần.`);
            const unsafe = amounts.find(value => !Number.isSafeInteger(value) || value > CFG.maxTarget);
            if (unsafe) return alert(`Target tối đa là ${formatVnd(CFG.maxTarget)}. Danh sách chưa được chạy.`);
            setQueue(amounts); setRunning(true); renderUI(); startBulkLoop();
        });
        panel.querySelector('#sapoToggle')?.addEventListener('click', () => {
            setRunning(!isRunning()); renderUI(); if (isRunning()) startBulkLoop();
        });
        panel.querySelector('#sapoCancel')?.addEventListener('click', () => {
            setRunning(false); setQueue([]); renderUI(); updateStatus('Đã hủy danh sách.');
        });
        panel.querySelector('#sapoRefresh')?.addEventListener('click', () => {
            localStorage.removeItem(STORAGE.products); updateStatus('Đã xóa cache sản phẩm.');
        });
    }

    function stableProductKey(raw, productName) {
        const id = raw.id ?? raw.variant_id ?? raw.variantId;
        const sku = String(raw.sku ?? raw.code ?? '').trim();
        if (id != null && String(id).trim()) return `id:${id}`;
        if (sku) return `sku:${norm(sku)}`;
        return `name:${norm(productName)}|price:${Math.round(parseApiNumber(raw.price))}`;
    }

    function normalizeVariant(raw, product) {
        const name = String(product.name ?? product.title ?? raw.name ?? raw.title ?? '').trim();
        const sku = String(raw.sku ?? raw.code ?? raw.barcode ?? '').trim();
        const salePrice = firstPositiveMoney(
            raw.price, raw.retail_price, raw.sale_price, raw.sell_price,
            raw.variant_price, product.price, product.retail_price
        );
        const costPrice = firstPositiveMoney(
            raw.cost_price, raw.cost, raw.import_price, raw.purchase_price,
            raw.initial_cost_price, product.cost_price, product.import_price
        );
        const inventoryRaw = raw.inventory_quantity ?? raw.inventory ?? raw.on_hand ?? raw.available;
        const inventory = inventoryRaw == null ? CFG.maxQty : Math.max(0, Math.floor(parseApiNumber(inventoryRaw)));
        return {
            key: stableProductKey(raw, name),
            id: raw.id ?? raw.variant_id ?? null,
            name,
            sku,
            query: sku || name,
            salePrice,
            costPrice,
            inventory
        };
    }

    async function fetchLatestProducts(force = false) {
        if (!force) {
            const cache = readJson(STORAGE.products, null);
            if (cache?.savedAt && Date.now() - cache.savedAt < CFG.cacheMs && Array.isArray(cache.items)) {
                const items = cache.items.map(p => ({ ...p, salePrice: Math.round(parseApiNumber(p.salePrice)), costPrice: Math.round(parseApiNumber(p.costPrice)) }))
                    .filter(p => p.key && p.query && p.salePrice > 0);
                if (items.length) { updateStatus(`Đã đọc ${items.length} mã hàng từ cache.`); return items; }
            }
        }

        const byKey = new Map();
        let consecutiveEmpty = 0;
        for (let page = 1; page <= CFG.maxPages && consecutiveEmpty < 2; page++) {
            updateStatus(`Đang tải sản phẩm, trang ${page}…`);
            const url = `/admin/products.json?limit=${CFG.pageSize}&page=${page}&order=created_at%20desc`;
            let response;
            try { response = await fetch(url, { credentials: 'same-origin' }); }
            catch (error) { console.warn('[Sapo Agent] fetch failed', error); await sleep(700); continue; }
            if (!response.ok) { console.warn('[Sapo Agent] HTTP', response.status, url); await sleep(500); continue; }
            const data = await response.json();
            const products = Array.isArray(data.products) ? data.products : [];
            if (!products.length) { consecutiveEmpty++; continue; }
            consecutiveEmpty = 0;
            for (const product of products) {
                const variants = Array.isArray(product.variants) && product.variants.length ? product.variants : [product];
                for (const raw of variants) {
                    const item = normalizeVariant(raw, product);
                    if (item.key && item.query && item.salePrice > 0 && item.inventory > 0) byKey.set(item.key, item);
                }
            }
            if (products.length < CFG.pageSize) break;
            await sleep(180);
        }
        const items = [...byKey.values()];
        if (!items.length) throw new Error('API không trả về sản phẩm có giá bán hợp lệ.');
        try { localStorage.setItem(STORAGE.products, JSON.stringify({ savedAt: Date.now(), items })); }
        catch (error) { console.warn('[Sapo Agent] Không lưu được cache', error); }
        updateStatus(`Đã tải ${items.length} mã hàng hợp lệ.`);
        return items;
    }

    function gcd(a, b) {
        a = Math.abs(Math.round(a)); b = Math.abs(Math.round(b));
        while (b) [a, b] = [b, a % b];
        return a || 1;
    }

    function shuffle(array) {
        const copy = [...array];
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy;
    }

    function buildCandidatePool(products, target, attempt) {
        const history = new Set(readJson(STORAGE.history, []));
        let valid = products.filter(p => p.salePrice > 0 && p.salePrice <= target && p.inventory > 0);
        const sorted = [...valid].sort((a, b) => a.salePrice - b.salePrice);
        const map = new Map();

        // Lấy mẫu cân bằng theo 6 dải giá. Không đẩy toàn bộ hàng rẻ lên đầu.
        const bandCount = 6;
        for (let band = 0; band < bandCount; band++) {
            const from = Math.floor(sorted.length * band / bandCount);
            const to = Math.floor(sorted.length * (band + 1) / bandCount);
            shuffle(sorted.slice(from, to)).slice(0, 34).forEach(p => map.set(p.key, p));
        }

        const idealLines = Math.max(4, Math.min(8, Math.round(3 + target / 75000)));
        const idealContribution = target / idealLines;
        [...valid].sort((a, b) => Math.abs(a.salePrice - idealContribution) - Math.abs(b.salePrice - idealContribution))
            .slice(0, 55).forEach(p => map.set(p.key, p));
        shuffle(valid.filter(p => !history.has(p.key))).slice(0, 70).forEach(p => map.set(p.key, p));
        shuffle(valid).slice(attempt * 25, attempt * 25 + 70).forEach(p => map.set(p.key, p));

        // Nhiều SKU có cùng giá tạo ra trạng thái DP giống hệt nhau. Chỉ giữ
        // tối đa 6 SKU/mức giá trong mỗi attempt để giảm mạnh CPU và bộ nhớ.
        const perPrice = new Map();
        const balanced = [];
        for (const product of shuffle([...map.values()])) {
            const count = perPrice.get(product.salePrice) || 0;
            if (count >= 6) continue;
            perPrice.set(product.salePrice, count + 1);
            balanced.push(product);
            if (balanced.length >= CFG.candidatesPerAttempt + 40) break;
        }
        return balanced;
    }

    function exactBoundedKnapsack(products, target) {
        if (!products.length || target <= 0) return null;
        let scale = target;
        for (const p of products) scale = gcd(scale, p.salePrice);
        const targetU = Math.round(target / scale);
        if (targetU > 350000) return exactSparseKnapsack(products, target);

        const previous = new Int32Array(targetU + 1); previous.fill(-2);
        const usedProduct = new Int32Array(targetU + 1); usedProduct.fill(-1);
        const usedQty = new Uint8Array(targetU + 1);
        const reached = [0]; previous[0] = -1;

        for (let pi = 0; pi < products.length; pi++) {
            const priceU = Math.round(products[pi].salePrice / scale);
            const max = Math.min(CFG.maxQty, Math.max(0, products[pi].inventory || CFG.maxQty));
            const before = reached.length;
            for (let ri = 0; ri < before; ri++) {
                const base = reached[ri];
                for (let qty = 1; qty <= max; qty++) {
                    const sum = base + priceU * qty;
                    if (sum > targetU) break;
                    if (previous[sum] !== -2) continue;
                    previous[sum] = base; usedProduct[sum] = pi; usedQty[sum] = qty; reached.push(sum);
                    if (sum === targetU) return reconstructDense(products, previous, usedProduct, usedQty, targetU);
                }
            }
        }
        return null;
    }

    function reconstructDense(products, previous, usedProduct, usedQty, sum) {
        const quantities = new Map();
        while (sum > 0) {
            const pi = usedProduct[sum];
            if (pi < 0) return null;
            const p = products[pi];
            quantities.set(p.key, (quantities.get(p.key) || 0) + usedQty[sum]);
            sum = previous[sum];
        }
        const byKey = new Map(products.map(p => [p.key, p]));
        return [...quantities].map(([key, qty]) => ({ ...byKey.get(key), qty }));
    }

    function exactSparseKnapsack(products, target) {
        const nodes = new Map([[0, null]]);
        let sums = [0];
        for (let pi = 0; pi < products.length; pi++) {
            const before = [...sums];
            const max = Math.min(CFG.maxQty, Math.max(0, products[pi].inventory || CFG.maxQty));
            for (const base of before) {
                for (let qty = 1; qty <= max; qty++) {
                    const sum = base + products[pi].salePrice * qty;
                    if (sum > target) break;
                    if (nodes.has(sum)) continue;
                    nodes.set(sum, { previous: base, pi, qty }); sums.push(sum);
                    if (sum === target) {
                        const quantities = new Map(); let cursor = target;
                        while (cursor > 0) {
                            const node = nodes.get(cursor); const p = products[node.pi];
                            quantities.set(p.key, (quantities.get(p.key) || 0) + node.qty); cursor = node.previous;
                        }
                        const byKey = new Map(products.map(p => [p.key, p]));
                        return [...quantities].map(([key, q]) => ({ ...byKey.get(key), qty: q }));
                    }
                }
            }
            if (sums.length > 450000) break;
        }
        return null;
    }

    async function naturalBoundedKnapsack(products, target) {
        if (!products.length || target <= 0) return null;
        const startedAt = globalThis.performance?.now?.() ?? Date.now();
        let stateWrites = 0;
        let transitions = 0;
        let scale = target;
        for (const p of products) scale = gcd(scale, p.salePrice);
        const targetU = Math.round(target / scale);
        if (targetU > CFG.maxScaledTarget) return null;
        const idealLines = Math.max(4, Math.min(8, Math.round(3 + target / 75000)));
        const maxLines = Math.min(12, idealLines + 4);
        const minLines = target < 50000 ? 2 : Math.max(3, idealLines - 3);
        const sortedPrices = products.map(p => p.salePrice).sort((a, b) => a - b);
        const bottomPrice = sortedPrices[Math.floor((sortedPrices.length - 1) * 0.2)] || 0;
        const expectedContribution = target / idealLines;
        const recent = new Set(readJson(STORAGE.history, []));
        // states[số dòng][số dòng quantity=1] -> Map(tổng, trạng thái).
        // Chiều thứ ba này tạo ràng buộc cứng: ít nhất một nửa giỏ phải là qty 1.
        const states = Array.from({ length: maxLines + 1 }, () =>
            Array.from({ length: maxLines + 1 }, () => new Map())
        );
        states[0][0].set(0, { score: 0, node: null });

        productLoop: for (let productIndex = 0; productIndex < products.length; productIndex++) {
            const product = products[productIndex];
            if (productIndex % 6 === 0) {
                await yieldToBrowser();
                const now = globalThis.performance?.now?.() ?? Date.now();
                if (now - startedAt > CFG.plannerBudgetMs) break productLoop;
            }
            const priceU = Math.round(product.salePrice / scale);
            const max = Math.min(CFG.maxQty, Math.max(0, product.inventory || CFG.maxQty));
            const optionScore = new Array(max + 1).fill(0);
            // Mỗi dòng có một mức đóng góp mong muốn hơi khác nhau để giỏ không
            // hội tụ vào cùng một mức giá/quantity.
            const personalExpected = expectedContribution * (0.58 + Math.random() * 0.84);
            for (let qty = 1; qty <= max; qty++) {
                const contribution = product.salePrice * qty;
                const closenessPenalty = Math.abs(Math.log(Math.max(0.05, contribution / personalExpected))) * 2.2;
                const qtyPenalty = [0, 0, 1.15, 4.2, 11][qty] || 15;
                const cheapPenalty = product.salePrice <= bottomPrice ? 1.8 : 0;
                const tinyPenalty = product.salePrice < target * 0.025 ? 1.2 : 0;
                const recentPenalty = recent.has(product.key) ? 0.9 : 0;
                optionScore[qty] = -closenessPenalty - qtyPenalty - cheapPenalty - tinyPenalty - recentPenalty + Math.random() * 0.35;
            }

            // Duyệt số dòng giảm dần để cùng một sản phẩm không thể được dùng hai lần.
            for (let lines = maxLines - 1; lines >= 0; lines--) {
                for (let ones = 0; ones <= lines; ones++) {
                    if (!states[lines][ones].size) continue;
                    const bases = [...states[lines][ones].entries()];
                    for (const [baseSum, baseState] of bases) {
                        for (let qty = 1; qty <= max; qty++) {
                            transitions++;
                            if (transitions % 50000 === 0) {
                                await yieldToBrowser();
                                const now = globalThis.performance?.now?.() ?? Date.now();
                                if (now - startedAt > CFG.plannerBudgetMs) break productLoop;
                            }
                            const sum = baseSum + priceU * qty;
                            if (sum > targetU) break;
                            const nextOnes = ones + (qty === 1 ? 1 : 0);
                            const score = baseState.score + optionScore[qty];
                            const old = states[lines + 1][nextOnes].get(sum);
                            if (!old || score > old.score) {
                                stateWrites++;
                                if (stateWrites > CFG.plannerMaxWrites) break productLoop;
                                states[lines + 1][nextOnes].set(sum, {
                                    score,
                                    node: { product, qty, previous: baseState.node }
                                });
                            }
                        }
                    }
                }
            }
        }

        let winner = null;
        for (let lines = minLines; lines <= maxLines; lines++) {
            const minimumOnes = Math.ceil(lines * 0.55);
            for (let ones = minimumOnes; ones <= lines; ones++) {
                const state = states[lines][ones].get(targetU);
                if (!state) continue;
                const finalScore = state.score - Math.abs(lines - idealLines) * 5.5 + ones * 0.4;
                if (!winner || finalScore > winner.score) winner = { ...state, score: finalScore, lines, ones };
            }
        }
        if (!winner) return null;

        const result = [];
        let node = winner.node;
        while (node) {
            result.push({ ...node.product, qty: node.qty });
            node = node.previous;
        }
        return result;
    }

    function naturalBasketScore(items, target, allProducts) {
        if (!items?.length) return -Infinity;
        const idealLines = Math.max(4, Math.min(8, Math.round(3 + target / 75000)));
        const expectedContribution = target / idealLines;
        const sortedPrices = allProducts.map(p => p.salePrice).sort((a, b) => a - b);
        const bottomPrice = sortedPrices[Math.floor((sortedPrices.length - 1) * 0.2)] || 0;
        const recent = new Set(readJson(STORAGE.history, []));
        const priceFrequency = new Map();
        let score = -Math.abs(items.length - idealLines) * 8;
        let qtyOneOrTwo = 0;

        for (const item of items) {
            const contribution = item.salePrice * item.qty;
            score -= Math.abs(Math.log(Math.max(0.05, contribution / expectedContribution))) * 2;
            score -= [0, 0, 1.4, 5, 14][item.qty] || 20;
            if (item.qty <= 2) qtyOneOrTwo++;
            if (item.salePrice <= bottomPrice) score -= 2.5;
            if (item.salePrice < target * 0.025) score -= 1.5;
            if (recent.has(item.key)) score -= 1;
            priceFrequency.set(item.salePrice, (priceFrequency.get(item.salePrice) || 0) + 1);
        }

        for (const count of priceFrequency.values()) if (count > 1) score -= (count - 1) * 4;
        score += priceFrequency.size * 0.8;
        score += qtyOneOrTwo * 1.2;
        if (new Set(items.map(x => x.qty)).size === 1 && items[0].qty > 1 && items.length >= 4) score -= 12;
        return score;
    }

    async function selectProducts(products, target) {
        const plannerStartedAt = globalThis.performance?.now?.() ?? Date.now();
        const valid = products.filter(p => Number.isInteger(p.salePrice) && p.salePrice > 0 && p.salePrice <= target);
        let best = null;
        for (let attempt = 0; attempt < CFG.selectAttempts; attempt++) {
            updateStatus(`Đang tối ưu giỏ tự nhiên ${formatVnd(target)} (${attempt + 1}/${CFG.selectAttempts})…`);
            const selected = await naturalBoundedKnapsack(buildCandidatePool(valid, target, attempt), target);
            if (selected?.length) {
                const merged = new Map();
                for (const item of selected) {
                    const old = merged.get(item.key);
                    merged.set(item.key, old ? { ...old, qty: old.qty + item.qty } : item);
                }
                const result = [...merged.values()];
                const total = result.reduce((sum, x) => sum + x.salePrice * x.qty, 0);
                if (total === target && result.every(x => x.qty >= 1 && x.qty <= CFG.maxQty)) {
                    const score = naturalBasketScore(result, target, valid);
                    if (!best || score > best.score) best = { result, score };
                }
            }
            await yieldToBrowser();
        }
        const plannerFinishedAt = globalThis.performance?.now?.() ?? Date.now();
        console.log('[Sapo Agent] planner finished', {
            target,
            durationMs: Math.round(plannerFinishedAt - plannerStartedAt),
            attempts: CFG.selectAttempts,
            found: Boolean(best)
        });
        if (!best) return null;
        const result = shuffle(best.result);
        localStorage.setItem(STORAGE.history, JSON.stringify(result.map(x => x.key)));
        return result;
    }

    function isVisible(el) {
        if (!el?.isConnected) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    function setNativeValue(input, value) {
        const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(input, String(value)); else input.value = String(value);
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(value) }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function click(el) {
        if (!el) return;
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        el.click();
    }

    async function waitFor(test, timeout, interval = 120) {
        const started = Date.now();
        while (Date.now() - started < timeout) {
            try { const result = test(); if (result) return result; } catch (_) {}
            await sleep(interval);
        }
        return null;
    }

    function getSearchInput() {
        const selectors = [
            'input[placeholder*="Tìm kiếm sản phẩm" i]', 'input[placeholder*="Tìm sản phẩm" i]',
            'input[placeholder*="Search product" i]', '[role="combobox"][type="text"]',
            'input[aria-label*="sản phẩm" i]'
        ];
        const candidates = selectors.flatMap(s => [...document.querySelectorAll(s)]).filter(isVisible);
        return candidates.find(x => !x.closest('[role="dialog"]')) || candidates[0] || null;
    }

    function suggestionCandidates() {
        const selectors = [
            '[role="listbox"] [role="option"]', '[role="option"]',
            '.MuiAutocomplete-popper li', '.MuiPopover-root li',
            '[class*="suggest"] [class*="item"]', '[class*="search-result"] [class*="item"]'
        ];
        const found = new Set();
        for (const selector of selectors) document.querySelectorAll(selector).forEach(x => { if (isVisible(x)) found.add(x); });
        return [...found];
    }

    function scoreProductText(text, item) {
        const value = norm(text);
        const sku = norm(item.sku);
        const name = norm(item.name);
        let score = 0;
        if (sku && new RegExp(`(^|\\s)${sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(value)) score += 100;
        else if (sku && value.includes(sku)) score += 60;
        if (name && value === name) score += 45;
        else if (name && value.includes(name)) score += 20;
        if (item.salePrice && parseVndText(text) === item.salePrice) score += 15;
        return score;
    }

    function scoreCartRow(text, item) {
        const value = norm(text);
        const sku = norm(item.sku);
        // Trong giỏ phải khớp SKU tuyệt đối. Không dùng tên làm fallback vì
        // nhiều biến thể Sapo có cùng tên và cùng giá nhưng là mã hàng khác.
        if (sku && !value.includes(sku)) return -100000;
        return scoreProductText(text, item);
    }

    async function chooseSuggestion(item) {
        const search = await waitFor(getSearchInput, 5000);
        if (!search) throw new Error('Không tìm thấy ô tìm kiếm sản phẩm.');
        search.focus(); setNativeValue(search, ''); await sleep(80); setNativeValue(search, item.query);
        search.dispatchEvent(new KeyboardEvent('keyup', { key: item.query.slice(-1), bubbles: true }));
        const choices = await waitFor(() => {
            const ranked = suggestionCandidates().map(el => ({ el, score: scoreProductText(el.textContent, item) }))
                .filter(x => x.score > 0).sort((a, b) => b.score - a.score);
            return ranked[0]?.score >= (item.sku ? 60 : 20) ? ranked[0].el : null;
        }, CFG.waitSuggestionMs);
        if (!choices) throw new Error(`Không thấy gợi ý khớp ${item.sku || item.name}.`);
        click(choices);
    }

    function quantityInputIn(container) {
        const sapoInput = container.matches?.('.order-line-item-quantity')
            ? container.querySelector('input')
            : container.querySelector('.order-line-item-quantity input');
        if (sapoInput && isVisible(sapoInput)) return sapoInput;
        const inputs = [...container.querySelectorAll('input')].filter(input => {
            if (!isVisible(input)) return false;
            const type = (input.type || '').toLowerCase();
            const label = norm(`${input.getAttribute('aria-label') || ''} ${input.getAttribute('placeholder') || ''} ${input.name || ''} ${input.id || ''} ${input.className || ''}`);
            const inputMode = norm(input.getAttribute('inputmode') || '');
            if (/tim kiem|tim san pham|search|product search|sku|barcode/.test(label)) return false;
            return type === 'number' || /quantity|qty|so luong/.test(label) ||
                ((inputMode === 'numeric' || inputMode === 'decimal') && (input.hasAttribute('min') || input.hasAttribute('max') || input.hasAttribute('step')));
        });
        return inputs.find(input => !input.disabled && !input.readOnly) || inputs[0] || null;
    }

    function visibleButtonsIn(container) {
        return [...container.querySelectorAll('button,[role="button"]')].filter(isVisible);
    }

    function elementSignature(el) {
        return norm(`${el?.textContent || ''} ${el?.getAttribute?.('aria-label') || ''} ${el?.title || ''} ${el?.className || ''} ${el?.innerHTML || ''}`);
    }

    function quantityControlIn(container) {
        const sapoControl = container.matches?.('.order-line-item-quantity')
            ? container
            : container.querySelector('.order-line-item-quantity');
        if (sapoControl && isVisible(sapoControl)) return sapoControl;
        const input = quantityInputIn(container);
        if (input) {
            let control = input.parentElement;
            for (let i = 0; i < 3 && control && control !== container; i++, control = control.parentElement) {
                if (visibleButtonsIn(control).length >= 2) return control;
            }
            return input.parentElement || container;
        }

        const possible = new Set();
        for (const button of visibleButtonsIn(container)) {
            let parent = button.parentElement;
            for (let level = 0; level < 4 && parent && parent !== container.parentElement; level++, parent = parent.parentElement) {
                const rect = parent.getBoundingClientRect();
                const buttons = visibleButtonsIn(parent);
                const numbers = (parent.textContent || '').match(/(^|\D)(\d{1,2})(?=\D|$)/g) || [];
                if (buttons.length >= 2 && buttons.length <= 4 && numbers.length && rect.width > 45 && rect.width < 320 && rect.height < 120) {
                    possible.add(parent);
                }
            }
        }
        return [...possible].sort((a, b) => {
            const ar = a.getBoundingClientRect(); const br = b.getBoundingClientRect();
            return (ar.width * ar.height) - (br.width * br.height);
        })[0] || null;
    }

    function rowFromQuantityControl(control) {
        if (!control) return null;
        let current = control;
        let fallback = null;
        for (let level = 0; level < 9 && current && current !== document.body; level++, current = current.parentElement) {
            if (!isVisible(current) || current.closest('[role="listbox"],.MuiAutocomplete-popper,.MuiPopover-root')) continue;
            const rect = current.getBoundingClientRect();
            if (rect.height > 35 && rect.height < 240 && rect.width > Math.max(420, control.getBoundingClientRect().width * 2.5)) {
                fallback = fallback || current;
                if (deleteButton(current)) return current;
                if (current.matches('tr,[role="row"],[data-testid*="cart-item"],[class*="cart-item"],[class*="order-item"],[class*="product-item"]')) return current;
            }
        }
        return fallback;
    }

    function textAnchorsFor(item) {
        const wantedSku = norm(item.sku);
        const wantedName = norm(item.name);
        const anchors = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
            const text = norm(node.nodeValue);
            if (!text || !node.parentElement || !isVisible(node.parentElement)) continue;
            if ((wantedSku && (text === wantedSku || text.includes(wantedSku))) || (!wantedSku && wantedName && text.includes(wantedName))) {
                if (!node.parentElement.closest('[role="listbox"],.MuiAutocomplete-popper,.MuiPopover-root')) anchors.push(node.parentElement);
            }
        }
        return anchors;
    }

    function cartContainers() {
        const exactControls = [...document.querySelectorAll('.order-line-item-quantity')].filter(isVisible);
        if (exactControls.length || document.querySelector('#main_layout')) {
            return [...new Set(exactControls.map(rowFromQuantityControl).filter(Boolean))];
        }

        // Chỉ dùng fallback cho phiên bản Sapo không có class ổn định ở trên.
        // Không quét toàn bộ button của document vì thao tác đó gây layout thrashing.
        const selectors = ['tr', '[role="row"]', '[data-testid*="cart-item"]', '[class*="cart-item"]', '[class*="order-item"]', '[class*="product-item"]', '[class*="line-item"]'];
        const set = new Set();
        selectors.forEach(s => document.querySelectorAll(s).forEach(el => {
            if (isVisible(el) && !el.closest('[role="listbox"],.MuiAutocomplete-popper,.MuiPopover-root')) set.add(el);
        }));
        return [...set].filter(el => quantityControlIn(el));
    }

    function findCartRow(item) {
        const containers = cartContainers();
        const rank = list => list.map(el => {
            const rect = el.getBoundingClientRect();
            const score = scoreCartRow(el.textContent, item) + (quantityControlIn(el) ? 30 : 0) - Math.min(20, rect.height / 20);
            return { el, score };
        }).filter(x => x.score > 20).sort((a, b) => b.score - a.score)[0]?.el || null;

        const direct = rank(containers);
        if (direct || document.querySelector('#main_layout')) return direct;

        // Legacy fallback: chỉ quét text khi class chính thức không tồn tại.
        const set = new Set(containers);
        for (const anchor of textAnchorsFor(item)) {
            let current = anchor;
            for (let level = 0; level < 9 && current && current !== document.body; level++, current = current.parentElement) {
                const control = quantityControlIn(current);
                if (control) {
                    const row = rowFromQuantityControl(control);
                    if (row && row.contains(anchor)) set.add(row);
                }
            }
        }
        return rank([...set]);
    }

    function readQuantity(row) {
        const input = quantityInputIn(row);
        if (input) return Math.max(0, parseInt(input.value, 10) || 0);
        const control = quantityControlIn(row);
        if (!control) return 0;
        const text = control.textContent || '';
        const matches = [...text.matchAll(/(^|\D)(\d{1,2})(?=\D|$)/g)].map(m => Number(m[2]));
        return matches.find(n => n >= 0 && n <= 99) ?? 0;
    }

    function findAdjustButton(row, direction) {
        const control = quantityControlIn(row) || row;
        if (control.matches?.('.order-line-item-quantity')) {
            const sapoButtons = visibleButtonsIn(control);
            return direction > 0 ? sapoButtons[sapoButtons.length - 1] || null : sapoButtons[0] || null;
        }
        const wanted = direction > 0 ? /^(\+|them|tang)$/ : /^(−|-|giam)$/;
        const aria = direction > 0 ? /plus|increase|tang|them|addicon/ : /minus|decrease|giam|subtract|removeicon/;
        const buttons = visibleButtonsIn(control);
        const semantic = buttons.find(b => wanted.test(norm(b.textContent)) || aria.test(elementSignature(b)));
        if (semantic) return semantic;
        const ordered = buttons.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
        return direction > 0 ? ordered[ordered.length - 1] || null : ordered[0] || null;
    }

    async function setCartQuantity(row, targetQty) {
        if (targetQty < 1 || targetQty > CFG.maxQty) throw new Error(`Số lượng ${targetQty} vượt giới hạn.`);
        const input = quantityInputIn(row);
        const sapoControl = row.matches?.('.order-line-item-quantity')
            ? row
            : row.querySelector('.order-line-item-quantity');

        // Với POS Sapo hiện tại, nút +/- cập nhật React ổn định hơn gán thẳng
        // input type=text. Luôn đọc lại sau MỖI click để không thể chạy vượt.
        if (!sapoControl && input) {
            input.focus(); input.select?.(); setNativeValue(input, targetQty);
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
            input.blur();
            if (await waitFor(() => readQuantity(row) === targetQty, 1800)) return true;
        }

        let current = readQuantity(row);
        if (current < 1 || current > CFG.maxQty) {
            throw new Error(`Quantity hiện tại là ${current}; agent không thao tác để tránh vượt giới hạn.`);
        }
        for (let guard = 0; guard < CFG.maxQty && current !== targetQty; guard++) {
            const direction = targetQty > current ? 1 : -1;
            const button = findAdjustButton(row, direction);
            if (!button) break;
            const before = current;
            click(button);
            const changed = await waitFor(() => {
                const next = readQuantity(row);
                return next !== before ? next : null;
            }, 1200, 80);
            if (!changed) return false;
            current = Number(changed);
            if (current < 1 || current > CFG.maxQty || current !== before + direction) {
                // Không click thêm khi UI nhảy sai bước hoặc đã ra ngoài 1..4.
                return false;
            }
        }
        return current === targetQty;
    }

    function getCartTotalUI() {
        if (!cachedCartTotalLabel?.isConnected || !isVisible(cachedCartTotalLabel)) {
            cachedCartTotalLabel = null;
            const root = document.querySelector('#main_layout') || document.body;
            const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            let textNode;
            while ((textNode = walker.nextNode())) {
                const t = norm(textNode.nodeValue);
                if (t === 'khach phai tra' || t === 'khach can tra' || t === 'tong thanh toan') {
                    const el = textNode.parentElement;
                    if (el && isVisible(el) && !el.closest('#paymentPopup,[role="dialog"]')) {
                        cachedCartTotalLabel = el;
                        break;
                    }
                }
            }
        }
        const label = cachedCartTotalLabel;
        if (!label) return 0;
        const scopes = [label.parentElement, label.parentElement?.parentElement, label.nextElementSibling].filter(Boolean);
        for (const scope of scopes) {
            const rest = scope.textContent.replace(label.textContent, '');
            if (/\d/.test(rest)) return parseVndText(rest);
        }
        return 0;
    }

    async function verifyCartTotal(expected, timeout = CFG.waitCartMs) {
        return Boolean(await waitFor(() => Math.abs(getCartTotalUI() - expected) <= CFG.verifyTolerance, timeout, 180));
    }

    async function addAndVerify(item, expectedTotal) {
        updateStatus(`Thêm ${item.sku || item.name} × ${item.qty}…`);
        if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > CFG.maxQty) {
            throw new Error(`${item.sku || item.name} có số lượng kế hoạch không hợp lệ: ${item.qty}.`);
        }
        const oldRow = findCartRow(item);
        if (!oldRow) await chooseSuggestion(item);
        const row = await waitFor(() => findCartRow(item), CFG.waitCartMs);
        if (!row) throw new Error(`Đã bấm gợi ý nhưng không thấy ${item.sku || item.name} trong giỏ.`);
        // Idempotent: luôn đặt đúng số lượng trong kế hoạch, tuyệt đối không cộng
        // thêm vào quantity đang có. Điều này giữ mọi dòng trong khoảng 1..4.
        const desired = item.qty;
        if (!(await setCartQuantity(row, desired))) throw new Error(`Không đặt được số lượng ${desired} cho ${item.sku || item.name}.`);
        if (!(await verifyCartTotal(expectedTotal))) {
            throw new Error(`Tổng giỏ là ${formatVnd(getCartTotalUI())}, cần ${formatVnd(expectedTotal)} sau khi thêm ${item.sku || item.name}.`);
        }
    }

    function deleteButton(row) {
        const buttons = visibleButtonsIn(row);
        const semantic = buttons.find(b => /delete|trash|xoa|closeicon|clearicon/.test(elementSignature(b)) || /^(x|×)$/.test(norm(b.textContent)));
        if (semantic) return semantic;
        const control = quantityControlIn(row);
        const controlButtons = new Set(control ? visibleButtonsIn(control) : []);
        const others = buttons.filter(b => !controlButtons.has(b)).sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
        const rowRect = row.getBoundingClientRect();
        const candidate = others[0];
        return candidate && candidate.getBoundingClientRect().left > rowRect.left + rowRect.width * 0.75 ? candidate : null;
    }

    async function clearCartUI() {
        updateStatus('Đang làm sạch giỏ hàng…');
        for (let pass = 0; pass < 30; pass++) {
            const rows = cartContainers();
            if (!rows.length && getCartTotalUI() === 0) return true;
            const row = rows[rows.length - 1];
            const del = deleteButton(row);
            if (del) click(del);
            else {
                const input = quantityInputIn(row);
                if (input) { setNativeValue(input, 0); input.dispatchEvent(new Event('change', { bubbles: true })); input.blur(); }
                else {
                    const current = readQuantity(row);
                    const minus = findAdjustButton(row, -1);
                    if (minus && current > 0) for (let i = 0; i < current; i++) { click(minus); await sleep(100); }
                }
            }
            await sleep(250);
            const confirm = [...document.querySelectorAll('[role="dialog"] button,.MuiDialog-root button')]
                .find(b => isVisible(b) && /^(xoa|dong y|xac nhan|ok)$/.test(norm(b.textContent)));
            if (confirm) { click(confirm); await sleep(300); }
        }
        return verifyCartTotal(0, 3000);
    }

    function fireF9() {
        ['keydown', 'keyup'].forEach(type => document.dispatchEvent(new KeyboardEvent(type, {
            key: 'F9', code: 'F9', keyCode: 120, which: 120, bubbles: true
        })));
    }

    function readPaymentRemaining(scope) {
        const labels = [...scope.querySelectorAll('span,div,p')].filter(el =>
            el.children.length === 0 && norm(el.textContent) === 'khach con phai tra'
        );
        for (const label of labels) {
            const row = label.parentElement;
            if (!row) continue;
            const rest = row.textContent.replace(label.textContent, '');
            if (/\d/.test(rest)) return parseVndText(rest);
        }
        return null;
    }

    async function executeAutoCheckout(target) {
        if (!CFG.autoCheckout) return true;
        if (!(await verifyCartTotal(target, 2500))) throw new Error('Tổng tiền thay đổi trước lúc thanh toán.');
        updateStatus('Đã khớp target; đang mở thanh toán…');
        fireF9();
        let completeButton = await waitFor(() => {
            const button = document.querySelector('#btnCompleteOrder');
            return button && isVisible(button) ? button : null;
        }, 5000);
        if (!completeButton) {
            const openButton = document.querySelector('#btnPayForOrder') ||
                [...document.querySelectorAll('button')].find(b => isVisible(b) && /thanh toan/.test(norm(b.textContent)));
            if (openButton) click(openButton);
            completeButton = await waitFor(() => {
                const button = document.querySelector('#btnCompleteOrder');
                return button && isVisible(button) ? button : null;
            }, 5000);
        }
        if (!completeButton) throw new Error('Không tìm thấy nút Hoàn tất trong cửa sổ thanh toán.');

        const dialog = completeButton.closest('[role="dialog"],.MuiDialog-root,.modal') || completeButton.parentElement;
        let remaining = readPaymentRemaining(dialog);
        if (remaining !== 0) {
            const suggested = dialog.querySelector(`#suggestedPaidAmounts button[value="${target}"]`);
            if (suggested && isVisible(suggested)) click(suggested);
            else {
                const paidInput = dialog.querySelector('#inputPaidAmount');
                if (paidInput) {
                    paidInput.focus(); paidInput.select?.(); setNativeValue(paidInput, target);
                    paidInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
                    paidInput.blur();
                }
            }
            const zeroed = await waitFor(() => readPaymentRemaining(dialog) === 0, 4000, 120);
            if (!zeroed) throw new Error(`Khách còn phải trả ${formatVnd(readPaymentRemaining(dialog) || 0)}; chưa thể hoàn tất.`);
        }

        completeButton = await waitFor(() => {
            const button = document.querySelector('#btnCompleteOrder');
            return button && isVisible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' ? button : null;
        }, 3000);
        if (!completeButton) throw new Error('Nút Hoàn tất đang bị vô hiệu hóa.');

        updateStatus('Đang bấm Hoàn tất…');
        click(completeButton);

        const panelClosed = await waitFor(() => {
            const button = document.querySelector('#btnCompleteOrder');
            return !button || !isVisible(button);
        }, 15000, 200);
        if (!panelClosed) throw new Error('Đã click Hoàn tất nhưng bảng thanh toán chưa đóng.');

        const cartReset = await waitFor(() => getCartTotalUI() === 0 || cartContainers().length === 0, 10000, 250);
        if (!cartReset) throw new Error('Bảng thanh toán đã đóng nhưng giỏ chưa được làm mới; chưa chuyển hóa đơn tiếp theo.');
        return true;
    }

    async function processTarget(target) {
        if (!Number.isSafeInteger(target) || target <= 0 || target > CFG.maxTarget) {
            throw new Error(`Target không an toàn. Giá trị tối đa là ${formatVnd(CFG.maxTarget)}.`);
        }

        // Lập và khóa kế hoạch trước khi đụng vào giỏ hàng.
        const products = await fetchLatestProducts();
        const selected = await selectProducts(products, target);
        if (!selected) throw new Error(`Không tìm được tổ hợp đúng ${formatVnd(target)} với giới hạn ${CFG.maxQty}/món.`);
        const planned = selected.reduce((sum, x) => sum + x.salePrice * x.qty, 0);
        if (planned !== target) throw new Error(`Lỗi nội bộ: tổ hợp ${formatVnd(planned)} khác target.`);
        if (selected.some(x => !Number.isInteger(x.qty) || x.qty < 1 || x.qty >= 5)) {
            throw new Error('Kế hoạch bị từ chối vì có mặt hàng không nằm trong khoảng 1–4.');
        }
        const largestQty = Math.max(...selected.map(x => x.qty));
        const singleQtyLines = selected.filter(x => x.qty === 1).length;
        updateStatus(`Đã khóa giỏ tự nhiên: ${selected.length} mã, ${singleQtyLines} mã ×1, quantity lớn nhất ${largestQty}.`);
        await sleep(350);

        if (!(await clearCartUI())) throw new Error(`Không dọn sạch được giỏ; tổng còn ${formatVnd(getCartTotalUI())}.`);

        let expected = 0;
        for (const item of selected) {
            if (!isRunning()) throw new Error('Đã tạm dừng.');
            expected += item.salePrice * item.qty;
            await addAndVerify(item, expected);
        }
        if (!(await verifyCartTotal(target, 3500))) throw new Error(`Kiểm tra cuối thất bại: ${formatVnd(getCartTotalUI())} ≠ ${formatVnd(target)}.`);
        await executeAutoCheckout(target);
    }

    async function startBulkLoop() {
        if (loopBusy) return;
        loopBusy = true;
        try {
            while (isRunning() && getQueue().length) {
                const queue = getQueue();
                const target = Math.round(parseApiNumber(queue[0]));
                renderUI();
                try {
                    await processTarget(target);
                    const latest = getQueue();
                    if (latest.length && Math.round(parseApiNumber(latest[0])) === target) latest.shift();
                    setQueue(latest);
                    updateStatus(`Hoàn tất hóa đơn ${formatVnd(target)}.`);
                    renderUI(); await sleep(1200);
                } catch (error) {
                    console.error('[Sapo Agent]', error);
                    setRunning(false); renderUI();
                    updateStatus(`TẠM DỪNG: ${error.message}`, true);
                    alert(`Sapo Agent đã tạm dừng.\n\n${error.message}\n\nHóa đơn hiện tại vẫn còn trong danh sách để bạn kiểm tra rồi bấm TIẾP TỤC.`);
                    break;
                }
            }
            if (!getQueue().length) { setRunning(false); renderUI(); updateStatus('Đã xử lý hết danh sách.'); }
        } finally { loopBusy = false; }
    }

    function boot() {
        const safetyMessage = sanitizeStoredQueue();
        renderUI();
        if (safetyMessage) updateStatus(safetyMessage, true);
        const observer = new MutationObserver(() => { if (!document.getElementById('sapo-auto-panel')) renderUI(); });
        // Panel là con trực tiếp của body; không cần theo dõi mọi mutation của SPA.
        observer.observe(document.body, { childList: true });
        if (isRunning() && getQueue().length) startBulkLoop();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();
