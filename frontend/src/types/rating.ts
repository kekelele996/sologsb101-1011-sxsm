/** 涨落态势：绳套曲线的两支 */
export type RiseFall = 'rising' | 'falling'

/** 涨落态势中文标签 */
export const RISE_FALL_LABELS: Record<RiseFall, string> = {
  rising: '涨水',
  falling: '落水'
}

/** 水位流量关系点据：参与幂函数定线的实测点 */
export interface Rating {
  id: string
  /** 所属测站 */
  stationId: string
  /** 水位（m） */
  stageM: number
  /** 流量（m³/s） */
  flowM3s: number
  /** 定线号：同一定线号的点据参与同一组拟合 */
  lineNo: string
  /** 涨落态势：涨水支 / 落水支 */
  riseFall: RiseFall
  /** 涨落态势是否由定线人员手动改定：手动改定后不再随水位 / 时间变动自动刷新 */
  riseFallManual?: boolean
  /** 点据来源测次号 */
  measureNo: string
  /** 点据时间 */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/** 幂函数定线结果：Q = a * (H - H0)^b */
export interface RatingFitResult {
  lineNo: string
  /** 涨落态势：该拟合属于哪一支 */
  riseFall: RiseFall
  /** 系数 a */
  a: number
  /** 指数 b */
  b: number
  /** 基线水位 H0（由点据自动搜索获得） */
  h0: number
  /** 参与拟合的点数 */
  sampleCount: number
  /** 拟合残差（相对误差绝对值均值，%） */
  meanResidualPct: number
  /** 最大残差（%） */
  maxResidualPct: number
  /** 决定系数 R²（对数域） */
  r2: number
  /** 是否可定线（点数 ≥ 3 且 b 为正） */
  valid: boolean
  /** 不可定线时的说明 */
  message: string
}

/** 关系点据页筛选条件（存于 ratingStore） */
export interface RatingFilterState {
  keyword: string
  stationIds: string[]
  lineNos: string[]
  verdicts: Array<'合格' | '超限'>
}

export function createEmptyRatingFilter(): RatingFilterState {
  return {
    keyword: '',
    stationIds: [],
    lineNos: [],
    verdicts: []
  }
}

/** 对 ln(Q) 与 ln(H - H0) 做最小二乘直线拟合，给定 H0 返回参数与残差 */
function fitWithBase(
  samples: Array<{ stageM: number; flowM3s: number }>,
  h0: number
): { a: number; b: number; residuals: number[] } | null {
  const points = samples.map((point) => ({
    x: Math.log(Math.max(point.stageM - h0, 1e-6)),
    y: Math.log(point.flowM3s)
  }))
  const n = points.length
  const sumX = points.reduce((sum, item) => sum + item.x, 0)
  const sumY = points.reduce((sum, item) => sum + item.y, 0)
  const sumXY = points.reduce((sum, item) => sum + item.x * item.y, 0)
  const sumXX = points.reduce((sum, item) => sum + item.x * item.x, 0)
  const denominator = n * sumXX - sumX * sumX
  if (Math.abs(denominator) < 1e-9) return null
  const b = (n * sumXY - sumX * sumY) / denominator
  const lnA = (sumY - b * sumX) / n
  const a = Math.exp(lnA)
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return null
  const residuals = samples.map((point) => {
    const predicted = a * Math.pow(Math.max(point.stageM - h0, 1e-6), b)
    return Math.abs((predicted - point.flowM3s) / point.flowM3s) * 100
  })
  return { a, b, residuals }
}

/**
 * 幂函数定线：Q = a×(H - H0)^b。
 * 在 [Hmin - 0.9×(Hmax-Hmin) , Hmin - 0.02] 区间内以 0.01 m 步长搜索 H0，
 * 取平均相对残差最小的一组参数，避免「基线贴近最低水位」造成幂函数畸变。
 * 同一测站按涨落态势分成涨水支 / 落水支分别拟合，单支不足 3 个点据不做定线。
 */
export function fitPowerCurve(
  points: Array<{ stageM: number; flowM3s: number }>,
  lineNo = 'A',
  riseFall: RiseFall = 'rising'
): RatingFitResult {
  const usable = points.filter(
    (point) => Number.isFinite(point.stageM) && Number.isFinite(point.flowM3s) && point.flowM3s > 0
  )
  const base: RatingFitResult = {
    lineNo,
    riseFall,
    a: 0,
    b: 0,
    h0: 0,
    sampleCount: usable.length,
    meanResidualPct: 0,
    maxResidualPct: 0,
    r2: 0,
    valid: false,
    message: ''
  }
  if (usable.length < 3) {
    return {
      ...base,
      message: `${RISE_FALL_LABELS[riseFall]}支只有 ${usable.length} 个点据，不足 3 个，无法定线（至少需要 3 个实测点）`
    }
  }
  const stageMin = Math.min(...usable.map((point) => point.stageM))
  const stageMax = Math.max(...usable.map((point) => point.stageM))
  const spread = Math.max(stageMax - stageMin, 0.05)
  const lowerH0 = stageMin - spread * 0.9
  const upperH0 = stageMin - 0.02

  let best: { a: number; b: number; h0: number; residuals: number[]; mean: number } | null = null
  const steps = Math.max(1, Math.round((upperH0 - lowerH0) / 0.01))
  for (let index = 0; index <= steps; index += 1) {
    const h0 = Number((lowerH0 + (index * (upperH0 - lowerH0)) / steps).toFixed(4))
    const candidate = fitWithBase(usable, h0)
    if (!candidate) continue
    const mean = candidate.residuals.reduce((sum, value) => sum + value, 0) / candidate.residuals.length
    if (!best || mean < best.mean) {
      best = { ...candidate, h0, mean }
    }
  }
  if (!best) {
    return { ...base, message: '水位点据过于集中，无法求解幂函数指数' }
  }

  // 对数域决定系数 R²
  const lnFlows = usable.map((point) => Math.log(point.flowM3s))
  const meanLnFlow = lnFlows.reduce((sum, value) => sum + value, 0) / lnFlows.length
  const totalSs = lnFlows.reduce((sum, value) => sum + (value - meanLnFlow) ** 2, 0)
  const residualSs = usable.reduce((sum, point) => {
    const predicted = best.a * Math.pow(Math.max(point.stageM - best.h0, 1e-6), best.b)
    const diff = Math.log(point.flowM3s) - Math.log(Math.max(predicted, 1e-6))
    return sum + diff * diff
  }, 0)
  const r2 = totalSs < 1e-9 ? 1 : Number(Math.max(0, 1 - residualSs / totalSs).toFixed(4))

  const valid = best.b > 0 && Number.isFinite(best.a)
  return {
    lineNo,
    riseFall,
    a: Number(best.a.toFixed(4)),
    b: Number(best.b.toFixed(3)),
    h0: Number(best.h0.toFixed(3)),
    sampleCount: usable.length,
    meanResidualPct: Number(best.mean.toFixed(2)),
    maxResidualPct: Number(Math.max(...best.residuals).toFixed(2)),
    r2,
    valid,
    message: valid
      ? `${RISE_FALL_LABELS[riseFall]}支定线有效`
      : `${RISE_FALL_LABELS[riseFall]}支指数 b ≤ 0，点据趋势异常，请检查水位与流量的对应关系`
  }
}

/** 由定线参数计算曲线流量 */
export function curveFlow(fit: RatingFitResult, stageM: number): number {
  if (!fit.valid) return 0
  const value = fit.a * Math.pow(Math.max(stageM - fit.h0, 1e-6), fit.b)
  return Number(value.toFixed(2))
}

/* --------------------------- 涨落态势默认标识 --------------------------- */

/** 参与默认标识计算的点据字段（旧数据可能缺 riseFall） */
export interface RiseFallLike {
  stationId: string
  stageM: number
  measuredAt: string
  riseFall?: RiseFall
}

/**
 * 新点据默认涨落标识：按相邻测次水位，比上一条高算涨水、低算落水。
 * 取同一测站内在册时间早于本点的最近一条点据比较水位；
 * 没有上一条或水位持平的默认涨水。
 */
export function suggestRiseFall(
  rows: RiseFallLike[],
  stationId: string,
  stageM: number,
  measuredAt: string
): RiseFall {
  const current = Date.parse(measuredAt)
  const prior = rows
    .filter((row) => row.stationId === stationId && Date.parse(row.measuredAt) < current)
    .sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt))
  if (prior.length === 0) return 'rising'
  return stageM >= prior[0].stageM ? 'rising' : 'falling'
}

/**
 * 旧点据缺标识的先补默认：按测站分组、按时间排序，
 * 水位不低于上一条算涨水，否则算落水；每组第一条默认涨水。
 * 已有人工标识的保留不改。
 */
export function backfillRiseFall<T extends RiseFallLike>(rows: T[]): T[] {
  const groups = new Map<string, T[]>()
  rows.forEach((row) => {
    const list = groups.get(row.stationId) ?? []
    list.push(row)
    groups.set(row.stationId, list)
  })
  groups.forEach((list) => {
    list.sort((a, b) => Date.parse(a.measuredAt) - Date.parse(b.measuredAt))
    let prevStage: number | null = null
    list.forEach((row) => {
      if (row.riseFall !== 'rising' && row.riseFall !== 'falling') {
        row.riseFall = prevStage === null || row.stageM >= prevStage ? 'rising' : 'falling'
      }
      prevStage = row.stageM
    })
  })
  return rows
}

/* ------------------------------- 绳套宽度 ------------------------------- */

/** 同一水位下涨水支与落水支的流量差（绳套宽度） */
export interface LoopWidth {
  lineNo: string
  stationId: string
  /** 参考水位（m）：两支水位范围重叠区间的中点 */
  stageM: number
  /** 涨水支流量（m³/s） */
  risingFlow: number
  /** 落水支流量（m³/s） */
  fallingFlow: number
  /** 绳套宽度：两支流量差绝对值（m³/s） */
  widthM3s: number
  /** 绳套宽度相对两支平均流量的百分比（%） */
  widthPct: number
}

/** 计算两支曲线在参考水位处的绳套宽度；任一支不可定线返回 null */
export function calcLoopWidth(
  lineNo: string,
  stationId: string,
  risingFit: RatingFitResult,
  fallingFit: RatingFitResult,
  stageMin: number,
  stageMax: number
): LoopWidth | null {
  if (!risingFit.valid || !fallingFit.valid) return null
  const stageM = Number(((stageMin + stageMax) / 2).toFixed(2))
  const risingFlow = curveFlow(risingFit, stageM)
  const fallingFlow = curveFlow(fallingFit, stageM)
  const widthM3s = Number(Math.abs(risingFlow - fallingFlow).toFixed(2))
  const avg = (risingFlow + fallingFlow) / 2
  return {
    lineNo,
    stationId,
    stageM,
    risingFlow,
    fallingFlow,
    widthM3s,
    widthPct: avg > 0 ? Number(((widthM3s / avg) * 100).toFixed(1)) : 0
  }
}
