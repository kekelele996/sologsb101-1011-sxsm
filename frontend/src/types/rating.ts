/** 涨落态势：洪水绳套的两个分支 */
export type TrendLabel = '涨水' | '落水'

export const TREND_LABELS: TrendLabel[] = ['涨水', '落水']

/** 态势来源：auto=按相邻测次水位自动判定；manual=定线人员人工改定 */
export type TrendSource = 'auto' | 'manual'

/** 水位流量关系点据：参与幂函数定线的实测点 */
export interface Rating {
  id: string
  /** 所属测站 */
  stationId: string
  /** 水位（m） */
  stageM: number
  /** 流量（m³/s） */
  flowM3s: number
  /** 定线号：同一定线号、同一态势的点据参与同一支曲线拟合 */
  lineNo: string
  /** 涨落态势（涨水支 / 落水支） */
  trend: TrendLabel
  /** 态势来源：自动判定或人工改定 */
  trendSource: TrendSource
  /** 点据来源测次号 */
  measureNo: string
  /** 点据时间 */
  measuredAt: string
  createdAt: number
  updatedAt: number
}

/** 幂函数定线结果：Q = a * (H - H0)^b（按定线号 × 涨落支分别拟合） */
export interface RatingFitResult {
  /** 支线键：stationId|lineNo|trend */
  branchKey: string
  /** 所属测站（同一支线点据测站一致时给出，否则为空） */
  stationId: string
  lineNo: string
  /** 涨水支 / 落水支 */
  trend: TrendLabel
  /** 系数 a */
  a: number
  /** 指数 b */
  b: number
  /** 基线水位 H0（由点据自动搜索获得） */
  h0: number
  /** 参与拟合的点数 */
  sampleCount: number
  /** 拟合水位下限（m），用于按支绘制曲线 */
  stageMinM: number
  /** 拟合水位上限（m） */
  stageMaxM: number
  /** 拟合残差（相对误差绝对值均值，%） */
  meanResidualPct: number
  /** 最大残差（%） */
  maxResidualPct: number
  /** 决定系数 R²（对数域） */
  r2: number
  /** 是否可定线（点数 ≥ 3 且 b 为正） */
  valid: boolean
  /** 不可定线时的说明（明确指出哪一支、缺几个点） */
  message: string
}

/** 同一水位两支曲线的流量差（绳套宽度采样点） */
export interface LoopWidthPoint {
  /** 所属测站 */
  stationId: string
  lineNo: string
  /** 水位（m） */
  stageM: number
  /** 涨水支曲线流量（m³/s） */
  riseFlow: number
  /** 落水支曲线流量（m³/s） */
  fallFlow: number
  /** 绳套宽度（m³/s）：落水支 − 涨水支 */
  widthM3s: number
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

/** 规范化态势取值，缺省一律按涨水支 */
export function normalizeTrend(value: unknown): TrendLabel {
  return value === '落水' ? '落水' : '涨水'
}

/** 支线分组键：同一测站、同一定线号、同一态势合为一支 */
export function branchKeyOf(stationId: string, lineNo: string, trend: TrendLabel): string {
  return `${stationId}|${lineNo}|${trend}`
}

/** 支线短标签，如 A-涨、A-落 */
export function branchLabel(lineNo: string, trend: TrendLabel): string {
  return `${lineNo}-${trend === '涨水' ? '涨' : '落'}`
}

/**
 * 按相邻测次水位判定单点态势：
 * 高于上一条算涨水，低于上一条算落水，与上一条持平沿用其态势，首点默认涨水。
 */
export function inferTrend(
  prevStageM: number | null,
  stageM: number,
  prevTrend: TrendLabel = '涨水'
): TrendLabel {
  if (prevStageM === null || !Number.isFinite(prevStageM)) return '涨水'
  if (stageM > prevStageM) return '涨水'
  if (stageM < prevStageM) return '落水'
  return prevTrend
}

type TrendRow = Pick<Rating, 'id' | 'stationId' | 'stageM' | 'measuredAt' | 'createdAt'>

/** 同测站点据按测次时间（其次创建时间、id）升序排列 */
function sortByMeasureTime<T extends TrendRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const time = a.measuredAt.localeCompare(b.measuredAt)
    if (time !== 0) return time
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id.localeCompare(b.id)
  })
}

/**
 * 为缺失涨落标识的旧点据补默认态势：
 * 按测站分组、测次时间排序后与相邻测次水位逐条比较，首点记涨水。
 * 返回 id → { trend, trendSource }，仅包含需要补标识的点据。
 */
export function deriveDefaultTrends(
  rows: Array<TrendRow & { trend?: unknown; trendSource?: unknown }>
): Map<string, { trend: TrendLabel; trendSource: TrendSource }> {
  const result = new Map<string, { trend: TrendLabel; trendSource: TrendSource }>()
  const byStation = new Map<string, typeof rows>()
  rows.forEach((row) => {
    const list = byStation.get(row.stationId) ?? []
    list.push(row)
    byStation.set(row.stationId, list)
  })
  byStation.forEach((stationRows) => {
    let prevStageM: number | null = null
    let prevTrend: TrendLabel = '涨水'
    sortByMeasureTime(stationRows).forEach((row) => {
      const hasValidLabel = row.trend === '涨水' || row.trend === '落水'
      const hasValidSource = row.trendSource === 'auto' || row.trendSource === 'manual'
      if (hasValidLabel && hasValidSource) {
        prevTrend = row.trend as TrendLabel
      } else if (hasValidLabel) {
        // 态势有效但来源缺失：沿用原态势，仅补默认来源
        result.set(row.id, { trend: row.trend as TrendLabel, trendSource: 'auto' })
        prevTrend = row.trend as TrendLabel
      } else {
        const trend = inferTrend(prevStageM, row.stageM, prevTrend)
        result.set(row.id, { trend, trendSource: 'auto' })
        prevTrend = trend
      }
      prevStageM = row.stageM
    })
  })
  return result
}

/**
 * 按最新水位 / 时间数据刷新「自动判定」点据的态势分组；人工改定（manual）的点据保持不动。
 * 返回 id → 最新态势（仅含自动点据），供定线前统一回写。
 */
export function refreshAutoTrends(
  rows: Array<Pick<Rating, 'id' | 'stationId' | 'stageM' | 'measuredAt' | 'createdAt' | 'trend' | 'trendSource'>>
): Map<string, TrendLabel> {
  const result = new Map<string, TrendLabel>()
  const byStation = new Map<string, typeof rows>()
  rows.forEach((row) => {
    const list = byStation.get(row.stationId) ?? []
    list.push(row)
    byStation.set(row.stationId, list)
  })
  byStation.forEach((stationRows) => {
    let prevStageM: number | null = null
    let prevTrend: TrendLabel = '涨水'
    sortByMeasureTime(stationRows).forEach((row) => {
      if (row.trendSource === 'manual') {
        // 人工改定的点据不参与自动刷新，但作为后续点据的相邻测次基准
        prevTrend = normalizeTrend(row.trend)
      } else {
        const trend = inferTrend(prevStageM, row.stageM, prevTrend)
        result.set(row.id, trend)
        prevTrend = trend
      }
      prevStageM = row.stageM
    })
  })
  return result
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
 * 单支点据少于 3 个时不定线，message 中说明是哪一支、缺多少点。
 */
export function fitPowerCurve(
  points: Array<{ stageM: number; flowM3s: number }>,
  lineNo = 'A',
  context?: { stationId?: string; trend?: TrendLabel }
): RatingFitResult {
  const trend = normalizeTrend(context?.trend)
  const stationId = context?.stationId ?? ''
  const usable = points.filter(
    (point) => Number.isFinite(point.stageM) && Number.isFinite(point.flowM3s) && point.flowM3s > 0
  )
  const base: RatingFitResult = {
    branchKey: branchKeyOf(stationId, lineNo, trend),
    stationId,
    lineNo,
    trend,
    a: 0,
    b: 0,
    h0: 0,
    sampleCount: usable.length,
    stageMinM: 0,
    stageMaxM: 0,
    meanResidualPct: 0,
    maxResidualPct: 0,
    r2: 0,
    valid: false,
    message: ''
  }
  if (usable.length < 3) {
    return {
      ...base,
      message: `${lineNo} 线${trend}支仅 ${usable.length} 个点据（不足 3 个），暂不定线`
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
    return { ...base, stageMinM: stageMin, stageMaxM: stageMax, message: `${trend}支水位点据过于集中，无法求解幂函数指数` }
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
    branchKey: branchKeyOf(stationId, lineNo, trend),
    stationId,
    lineNo,
    trend,
    a: Number(best.a.toFixed(4)),
    b: Number(best.b.toFixed(3)),
    h0: Number(best.h0.toFixed(3)),
    sampleCount: usable.length,
    stageMinM: stageMin,
    stageMaxM: stageMax,
    meanResidualPct: Number(best.mean.toFixed(2)),
    maxResidualPct: Number(Math.max(...best.residuals).toFixed(2)),
    r2,
    valid,
    message: valid
      ? `${lineNo} 线${trend}支定线有效`
      : `${lineNo} 线${trend}支指数 b ≤ 0，点据趋势异常，请检查水位与流量的对应关系`
  }
}

/** 由定线参数计算曲线流量 */
export function curveFlow(fit: RatingFitResult, stageM: number): number {
  if (!fit.valid) return 0
  const value = fit.a * Math.pow(Math.max(stageM - fit.h0, 1e-6), fit.b)
  return Number(value.toFixed(2))
}

interface BranchGroupInput {
  stationId: string
  lineNo: string
  trend?: unknown
  stageM: number
  flowM3s: number
}

/**
 * 把点据按「测站 × 定线号 × 涨落态势」分组，逐支拟合幂函数曲线。
 * 涨水支、落水支分别得到一条 RatingFitResult。
 */
export function buildBranchFits(rows: BranchGroupInput[]): RatingFitResult[] {
  const groups = new Map<
    string,
    { stationId: string; lineNo: string; trend: TrendLabel; points: Array<{ stageM: number; flowM3s: number }> }
  >()
  rows.forEach((row) => {
    const trend = normalizeTrend(row.trend)
    const key = branchKeyOf(row.stationId, row.lineNo, trend)
    const group = groups.get(key) ?? { stationId: row.stationId, lineNo: row.lineNo, trend, points: [] }
    group.points.push({ stageM: row.stageM, flowM3s: row.flowM3s })
    groups.set(key, group)
  })
  return Array.from(groups.values()).map((group) =>
    fitPowerCurve(group.points, group.lineNo, { stationId: group.stationId, trend: group.trend })
  )
}

/** 查找某点据所属支线的拟合成果 */
export function findBranchFit(
  fits: RatingFitResult[],
  stationId: string,
  lineNo: string,
  trend: TrendLabel
): RatingFitResult | undefined {
  return fits.find((fit) => fit.branchKey === branchKeyOf(stationId, lineNo, trend))
}

/**
 * 在两支曲线共同覆盖的水位重叠区内均匀采样，计算同一水位两支的流量差（绳套宽度）。
 * 仅当涨水支、落水支均已定线且存在水位重叠区时返回采样点。
 */
export function buildLoopWidths(
  fits: RatingFitResult[],
  sampleCount = 9
): LoopWidthPoint[] {
  const widths: LoopWidthPoint[] = []
  const pairKeys = new Set<string>()
  fits.forEach((fit) => {
    if (!fit.valid) return
    const pairKey = `${fit.stationId}|${fit.lineNo}`
    if (pairKeys.has(pairKey)) return
    const otherTrend: TrendLabel = fit.trend === '涨水' ? '落水' : '涨水'
    const other = findBranchFit(fits, fit.stationId, fit.lineNo, otherTrend)
    if (!other || !other.valid) return
    pairKeys.add(pairKey)
    const rise = fit.trend === '涨水' ? fit : other
    const fall = fit.trend === '落水' ? fit : other
    const overlapMin = Math.max(rise.stageMinM, fall.stageMinM)
    const overlapMax = Math.min(rise.stageMaxM, fall.stageMaxM)
    if (overlapMax - overlapMin < 1e-6) return
    for (let index = 0; index < sampleCount; index += 1) {
      const stageM = Number(
        (overlapMin + ((overlapMax - overlapMin) * index) / (sampleCount - 1 || 1)).toFixed(2)
      )
      const riseFlow = curveFlow(rise, stageM)
      const fallFlow = curveFlow(fall, stageM)
      widths.push({
        stationId: fit.stationId,
        lineNo: fit.lineNo,
        stageM,
        riseFlow,
        fallFlow,
        widthM3s: Number((fallFlow - riseFlow).toFixed(2))
      })
    }
  })
  return widths
}
