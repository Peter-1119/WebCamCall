# 點陣 Data Matrix（PCB DPM）強健度：研究筆記與待試清單

> 狀態：2026-09-18 第一輪實作完成（E1–E3、B1、B2、B3、B4、C1、C3、A1），結果見 §6。素材：`pics/DataMatrix/`（17 張照片 + 影片 `IMG_3459.MOV` 抽 448 幀），皆不進 repo。
> 評測工具：`node scripts/sim-live.mjs <framesDir>`（逐幀即時模擬）、`node scripts/eval-dm.mjs <dir>`（拍照模式）。

## 1. 先弄清楚「為什麼失敗」——影片逐幀的三種失敗型態

把三個代表幀的碼區域放大 6× 看過後，失敗原因不是單一的：

| 幀 | 觀察 | 失敗原因 | 演算法能救嗎 |
|---|---|---|---|
| f00118（有解） | 點清楚、深色點在亮銅上、旋轉約 30°、碼寬 ≈ 70 px（模組 ≈ 3 px） | — | 已由核 3 + 尺寸提示解出 |
| f00448（無解） | **點幾乎完全看不見**，銅面呈均勻深褐色，只看得到外框方框 | **打光角度**：鑽孔/雷雕點只在特定入射角有對比 | ✗ 任何前處理都生不出不存在的對比 |
| f00600（無解） | 點看得到但**動態/失焦模糊**、板子傾斜（透視）、對比低 | 模糊 + 透視 + 低對比 | △ 部分（去模糊、透視校正），但成本高 |

另外從 zxing 的行為看：448 幀裡只有 36 幀「找得到位置」（8%），其餘連候選都沒有。
**瓶頸在定位（localization），不在膨脹核的選擇**——盲目輪替核或把候選放大再解（已試，2/16 不變）都不會改善，因為根本沒有候選。

業界共識（Cognex / Keyence / Dynamsoft 的 DPM 文件）：DPM 的第一問題永遠是**取像**（打光、對比、每模組像素數），演算法只是第二層。

## 2. 學術界 / 業界做法摘要

- **De-dotting（業界）**：把離散的點「橋接」成連續模組後再交給一般 DM 解碼器。我們現在的膨脹前處理就是這一類，商用 SDK（Dynamsoft、2DTG、barKoder）的 DPM 模式也是先做這步。
- **L 型定位（學術主流）**：Data Matrix 的實線 L 邊 + 虛線時序邊。做法有 Radon / Hough 直線偵測、線段偵測後組合成 L（Huang 2013）、以及 2024 年 MDPI Sensors 的「L 型虛線邊 + 中心先驗」（先假設碼在畫面中央附近，再找虛線邊）。Karrach 等 2021 年的比較研究（J. Imaging）整理了低解析度下各種定位法的優劣：Hough/Radon 慢、但對低解析度穩；連通元件法快但對雜訊敏感。
- **zxing-cpp 的 DM 偵測器**（我們實際用的）：`DetectNew` 是**邊緣追蹤**——沿黑白邊界走出實線 L 邊，再沿虛線邊算模組數（相鄰點間距 > 1.9× 單位距離視為空隙）。要求 L 邊至少 8 px、底邊至少 10 px、**不處理點陣**（所以我們才要膨脹）。膨脹後 L 邊變成實線沒問題，但 3 px 模組的虛線邊經膨脹後間隙常被填平 → 模組數算錯 → `ChecksumError`。這解釋了 f00448 那種「有候選但校驗錯」。
- **深度學習定位**（2023，Applications of Modelling and Simulation）：YOLOv5 找點陣 DM 位置，97.8% 準確率。定位問題交給 CNN，解碼還是傳統。
- **多幀融合**（影片超解析度領域）：對齊後平均 / 投票。條碼領域少有論文，但 rectify 後做位元投票是工業讀碼器（連續掃描模式）常見的實作。
- **ISO/IEC 16022 + ISO 29158（AIM DPM 品質規範）**：DPM 驗證用的是特定打光幾何（30°/45°/90° 環形光、暗場光），本身就承認打光是前提。

參考：
- Karrach et al., "Comparative Study of Data Matrix Codes Localization and Recognition Methods", J. Imaging 2021 — https://www.mdpi.com/2313-433X/7/9/163
- "A Data Matrix Code Recognition Method Based on L-Shaped Dashed Edge Localization Using Central Prior", Sensors 2024 — https://www.mdpi.com/1424-8220/24/13/4042
- Huang et al., "Data Matrix Code Location Based on Finder Pattern Detection and Bar Code Border Fitting", 2013 — https://www.researchgate.net/publication/258384910
- "Decoding Dot Peen Data Matrix Code with Deep Learning Capability for Product Traceability", 2023 — https://arqiipubl.com/ojs/index.php/AMS_Journal/article/view/385
- zxing-cpp `DMDetector.cpp` — https://github.com/zxing-cpp/zxing-cpp/blob/master/core/src/datamatrix/DMDetector.cpp
- Dynamsoft DPM 說明 — https://www.dynamsoft.com/barcode-reader/direct-part-marking/ ；barKoder DPM 指南 — https://barkoder.com/blog/direct-part-marking-what-dpm-codes-are-and-how-to-scan-them
- GS1 DataMatrix Guideline — https://www.gs1.org/docs/barcodes/GS1_DataMatrix_Guideline.pdf

## 3. 待試清單（依「預期效益 ÷ 成本」排序）

成本：S = 半天內、M = 1–2 天、L = 一週以上。每項都先在 `sim-live.mjs` / `eval-dm.mjs` 上量化，再決定要不要進 core。
**所有重流程只能掛在 `dotted` / 拍照模式，不得動到 QR / 1D 的每幀成本**（已定案）。

### A. 取像端（最大槓桿，幾乎零演算法成本）

| # | 方法 | 預期 | 成本 | 備註 |
|---|---|---|---|---|
| A1 | **相機 zoom 2–3×**（`scanner.setZoom()`，iPad 實測 1–10） | 模組 3 px → 6–9 px，直接落進照片實測「穩定可解」區間 | S | 加 `<BarcodeScanner :zoom>` prop + playground 滑桿；需實機驗證 zoom 是否為光學裁切（畫質）|
| A2 | 提高擷取解析度（gUM 要 `width: 3840`） | 同上，但每幀像素 ×4，主執行緒 drawImage 成本 ↑ | S | iPad Safari 是否給 4K 需實機驗證 |
| A3 | 對焦 / 曝光 constraints（`focusMode`、`focusDistance`、`exposureCompensation`） | 減少 f00600 型失焦 | S | Safari 支援度極可能是 ✗，feature detect 後決定 |
| A4 | **操作指引**：`dotted` 模式下「找到位置但一直解不出」→ 發 `move-closer`；「連候選都沒有 N 秒」→ 發 `align`/新增 `tilt`（換角度避免銅面無對比） | 廠內實際命中率最直接的提升 | S | 純回饋訊號，不動解碼流程 |

### B. 前處理（每幀、便宜）

| # | 方法 | 預期 | 成本 | 備註 |
|---|---|---|---|---|
| B1 | zxing `binarizer` 選項：`GlobalHistogram` / `FixedThreshold` vs 預設 `LocalAverage` | 膨脹後的影像其實已接近二值，LocalAverage 的視窗可能反而吃掉小碼 | S | 一行選項，先試 |
| B2 | **Top-hat / Black-hat**（原圖 − 開運算）去背景 | 把小點從大片銅面 / 走線分離出來，正是 DPM 教科書第一步；也直接改善 f00448 型的低對比 | S | 用現有 van Herk min/max 就能做，核 ≈ 2–3× 模組 |
| B3 | **DoG / LoG 點濾波**（σ ≈ 模組 / 2）+ 門檻 | 只留「點狀」特徵、壓掉走線與邊緣，給定位器更乾淨的輸入 | S–M | 可分離高斯，成本可控 |
| B4 | 局部自適應二值化（Sauvola / Bradley）取代百分位拉伸 | 銅面不均勻打光 | S | 積分影像實作 |
| B5 | 去模糊（unsharp / 簡易 Wiener） | f00600 型 | M | 通常收益小，排後面 |
| B6 | 目前做法：對比拉伸 + 絕對核階梯 + **候選尺寸提示核**（已做，0/448 → 3/448） | — | 已完成 | 保留為 baseline |

### C. 定位（真正的瓶頸）

| # | 方法 | 預期 | 成本 | 備註 |
|---|---|---|---|---|
| C1 | **時間追蹤 ROI**：一旦某幀 located（即使沒解出），接下來 N 幀鎖定該區域做全解析度 + 全部變體 | 把 33 個 located-only 幀變成連續的高強度嘗試；影片中碼移動很慢 | S–M | 只在 located 之後啟動，不影響一般流程 |
| C2 | **方框先驗**（專案特有）：此廠 2DID 都刻在一個印刷方框內（見三個幀），先用邊緣 + 直線 / 輪廓找 70–150 px 的方框 → 直接得到位置、旋轉、尺度 | 方框對比遠高於點，幾乎每幀都找得到；等於「中心先驗」論文的強化版 | M | **要先確認廠內所有板子都有這個框**（待問） |
| C3 | 點狀 blob 聚類定位：B3 之後取連通元件，找「一群小 blob 在 ~22×22 網格內」的區域，最小面積矩形當四邊形 | 學術主流做法，不依賴 zxing 的 L 邊追蹤 | M–L | 通用，但雜訊多的 PCB 上假候選會多 |
| C4 | 深度學習定位（YOLO-nano / 小型 CNN，ONNX → WebGPU/wasm） | 論文 97.8%；但要標資料、模型 ≥ 數 MB、iPad 推論時間未知 | L | 最後手段 |

### D. 取樣 / 解碼

| # | 方法 | 預期 | 成本 | 備註 |
|---|---|---|---|---|
| D1 | **透視校正 + 固定尺度重取樣**：拿到四邊形（C1/C2/C3 或 zxing located）後 warp 成軸對齊、每模組固定 8 px 的方形（22 模組 → 176 px），再用固定核膨脹 | 膨脹核不再跟距離綁定；zxing 的虛線邊模組計數在固定 8 px/模組下很穩；同時解決旋轉/透視 | M | 需要一個小的 homography + 雙線性取樣（純 JS，176² 很便宜） |
| D2 | **直接網格取樣 → 合成乾淨 DM 圖**：D1 之後在每個模組中心取樣、二值化成 22×22 位元矩陣，畫成乾淨的黑白 DM 交給 zxing（`isPure`），讓 RS 糾錯處理錯位元 | 完全繞過 zxing 對點陣的定位/計數問題；工業讀碼器的做法 | M | 需假設或枚舉符號尺寸（10–26） |
| D3 | **多幀投票**：D1/D2 的位元矩陣連續幾幀做多數決（或校正後灰階平均） | 低對比 / 雜訊幀的 SNR 提升；影片這種連續取像特別適合 | M | 依賴 C1 的追蹤 |
| D4 | 替代解碼器 libdmtx（wasm）比對 | 其區域偵測是不同機制（邊緣跟隨），可能在 3 px 模組上互補 | M | 多一個 wasm 體積，只在 dotted 模式載入 |
| D5 | 商用 SDK（Dynamsoft / Scandit）DPM 模式做為上限參考 | 知道「最好能到多少」 | S（試用） | 授權費，只做基準 |

### E. 量測工具（做任何優化前先補）

| # | 工具 | 目的 |
|---|---|---|
| E1 | 逐幀標註碼位置（半自動：用有解幀的位置 + 追蹤內插） | 才能把每幀分成「打光不可見 / 模糊 / 可見但沒定位到 / 定位到沒解出」四類，各方法只對其中某類有效 |
| E2 | 每幀對比度指標（碼區域內 DoG 響應能量） | 量化 A4 的觸發條件、判斷 f00448 型佔比 |
| E3 | `sim-live.mjs` 加 `--variant` 開關，可個別開關 B/C/D 各項 | A/B 對比同一組幀 |

## 4. 建議的執行順序

1. **E1–E3**：先把影片分類，知道每個失敗型態的比例（半天）。沒有這個，後面每項都無法公平評分。
2. **A1 + A4**：zoom prop + 回饋碼——幾乎免費、廠內最有感。同時請現場拿 iPad 用 zoom 2–3 重拍同一塊板子（照片 + 影片）當新素材。
3. **B1、B2**：一行選項與一個 top-hat，各半天，可能直接拉高 located 率。
4. **C1 → D1 → D3**：追蹤 + 校正 + 投票，這一組是「影片連續掃描」情境的正解，估 3–4 天。
5. **C2**：若確認方框是廠內標準設計，做方框定位（2 天），它會讓 D1 幾乎每幀都有輸入。
6. **D2**、**C3**、**D4**：視 4/5 的結果決定要不要做。
7. **C4**：不建議現在做。

## 5. 待確認（需要現場資訊）

- 廠內所有 2DID 是否都刻在同一種印刷方框內？框的尺寸 / 符號尺寸（22×22？）是否固定？
- 現場打光：是否可以加一個低角度的 LED 環或固定拍攝角度？（DPM 讀碼器全靠這個）
- 作業距離：操作員能否接受「2DID 佔掃描框 1/4 寬以上」的距離，或必須整板入鏡？

## 6. 第一輪結果（2026-09-18）

工具：`scripts/dm-track.mjs`（NCC 逐幀標註碼位置，四個錨點，448 幀 436 幀有標）、`scripts/dm-bench.mjs`（oracle ROI 上比較前處理）、`scripts/sim-live.mjs`（鏡射 core 的完整策略）。

### E：影片分類（oracle ROI = 已知位置、全部變體）

- 可解幀集中在 0–4 s、13–14 s、16–18 s、20–21 s；7–12 s（銅面深色、點不可見）與 22–29 s（模糊 / 傾斜）即使位置已知、全部變體也解不出。
- 對比最低的四分位（打光問題）所有方法 0 命中。→ 理論上限約 100/448。

### B：前處理（oracle ROI，218 幀，exhaustive 變體）

| 方法 | 命中 | 備註 |
|---|---|---|
| 目前做法（對比拉伸 + 膨脹） | 4.1% | |
| B1 `binarizer: GlobalHistogram` / `FixedThreshold` | 1.4% / 0.5% | 更差，**不採用** |
| B2 **black-hat r=3** + 膨脹 | **20.2%** | 採用（`DottedVariant.hat`）|
| B3 DoG (1,3) | 20.2% | 與 B2 同級，B2 用現有 van Herk 較便宜 |
| B4 Sauvola | 11.0% | 不採用 |
| 放大 ×2 後再做 | 不增反減（16.5%） | 不採用 |
| black-hat 用在**整張**近拍照片 | 14/17 → 5/17 | 帽濾波只能用在小裁切（遠拍小碼），不能用在整幀 |

命中的核只有 3 / 5（模組 3 px），與 `kernelFromSymbolWidth` 一致。

### C / D：定位與追蹤（sim-live，448 幀）

| 策略 | 命中 |
|---|---|
| 0.1.5 之前（盲目輪替） | 3 |
| + 候選尺寸提示核 | 3 |
| + 裁切幀用帽濾波變體 | 18 |
| + 追蹤（aux 裁切與主幀同幀、先解） | 54 |
| + 點密度定位（C3，解析度夠就 Worker 內就地裁解） | **69**（首次命中 0.2 s、最長空窗 8.5 s）|
| 定位每 2 / 3 個整幀跑一次 | 60 / 54（成本換命中，目前每幀都跑）|

設計上的取捨：
- 一幀一個請求的架構下，「追蹤裁切 / 整幀交替出幀」只有 65；改成**主幀 + aux 裁切同一個請求**（grabber 第二個 canvas、Worker 先解 aux）不犧牲發現率。
- 點密度候選在解析度 ≥ 0.75× 時就地解，失敗的候選**不再**排到下一幀（原本會吃掉 3/4 的發現幀，命中掉到 22）。
- 成本（Node）：aux ~13 ms、整幀變體 + 定位 90–120 ms（帽濾波 4 趟 min/max 佔大半）。實機（iPad Safari）要量：decode p50/p95 看 `stats`。

### 尚未做 / 下一輪

- A1 zoom prop 已加（`<BarcodeScanner :zoom>` + playground 滑桿），**需要現場用 zoom 2–3 重拍同一塊板**當新素材。
- A4 打光提示（點不可見時換角度）：需要對比指標，未做。
- C2 方框先驗：待確認廠內是否所有 2DID 都有印刷方框。
- D1 透視校正重取樣、D2 直接網格取樣、D3 多幀投票：上限分析顯示剩餘失敗幀多為打光 / 模糊，這三項預期增益有限，先擱置。
- 帽濾波成本：如果實機每幀 > 100 ms，考慮定位改在 640 寬縮圖上做（候選再回原圖就地解）。
