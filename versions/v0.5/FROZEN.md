# 冻结快照：v0.5（0.5.0）

本目录是 0.5.0 的历史快照，**不再改动**。

- 冻结时点：2026-11-13
- 最后版本：0.5.0（`pages-verify` 合并后校验上线）
- 现行版本见 `versions/CURRENT`（当前 `v0.6`）
- 门禁只审 CURRENT，本目录不参与 Q2/Q3/Q5/Q9/Q10/Q13 与 CodeQL

## 为什么保留

0.5.0 是第一个带「合并后校验」的版本，`tools/pages-verify.mjs` 与
`.github/workflows/pages-verify.yml` 从这里引入；保留快照用于对照当时的
`ui/` 与 `src/` 形态，方便回溯「某个行为是哪一版改的」。
