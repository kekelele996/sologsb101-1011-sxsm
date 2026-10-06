/**
 * 定线 store：维护水位流量关系点据、涨落态势、比测记录与分支定线参数。
 * 同一测站的点据按态势分为涨水支、落水支分别拟合幂函数曲线；
 * 比测曲线流量取点据所属支线的拟合值。供关系点据页（/ratings）与导出页（/export）共用。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Compare } from '@/types/compare'
import { DEVIATION_LIMIT_PCT, calcDeviationPct, judgeDeviation, type CompareRow } from '@/types/compare'
import type { Rating, RatingFitResult, TrendLabel } from '@/types/rating'
import {
  branchKeyOf,
  buildBranchFits,
  buildLoopWidths,
  createEmptyRatingFilter,
  curveFlow,
  findBranchFit,
  inferTrend,
  normalizeTrend,
  refreshAutoTrends,
  type LoopWidthPoint,
  type RatingFilterState
} from '@/types/rating'
import type { Station } from '@/types/station'

export const useRatingStore = defineStore('rating', () => {
  const ratings = ref<Rating[]>([])
  const compares = ref<Compare[]>([])
  const stations = ref<Station[]>([])
  const ready = ref(false)
  const error = ref<string | null>(null)
  const filter = ref<RatingFilterState>(createEmptyRatingFilter())
  /** 当前定线号（跨页保留） */
  const activeLineNo = ref<string>('A')
  const deviationLimitPct = ref<number>(DEVIATION_LIMIT_PCT)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<Rating>(() => db.ratings).subscribe((rows) => {
      ratings.value = rows
      ready.value = true
      error.value = null
    })
    watchTable<Compare>(() => db.compares).subscribe((rows) => {
      compares.value = rows
    })
    watchTable<Station>(() => db.stations).subscribe((rows) => {
      stations.value = rows
    })
  }

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string =>
    stations.value.find((station) => station.id === stationId)?.name ?? '未知测站'

  /** 全量支线拟合结果：测站 × 定线号 × 涨落态势 各一条曲线 */
  const allFits = computed<RatingFitResult[]>(() => buildBranchFits(ratings.value))

  /** 当前定线号下的支线拟合结果（按测站、涨水/落水排列） */
  const activeLineFits = computed<RatingFitResult[]>(() =>
    allFits.value
      .filter((fit) => fit.lineNo === activeLineNo.value)
      .sort((a, b) => {
        const station = a.stationId.localeCompare(b.stationId)
        if (station !== 0) return station
        return a.trend === b.trend ? 0 : a.trend === '涨水' ? -1 : 1
      })
  )

  /** 当前定线号下涉及的测站（保持点据首次出现顺序） */
  const activeLineStationIds = computed<string[]>(() => {
    const ids: string[] = []
    ratings.value.forEach((rating) => {
      if (rating.lineNo === activeLineNo.value && !ids.includes(rating.stationId)) ids.push(rating.stationId)
    })
    return ids
  })

  /** 绳套宽度：两支均有效时按水位重叠区采样（全量，供导出） */
  const loopWidths = computed<LoopWidthPoint[]>(() => buildLoopWidths(allFits.value))

  /** 当前定线号的绳套宽度采样（供关系点据页标注） */
  const activeLoopWidths = computed<LoopWidthPoint[]>(() =>
    loopWidths.value.filter((item) => item.lineNo === activeLineNo.value)
  )

  /** 当前定线号绳套宽度统计（m³/s） */
  const activeLoopSummary = computed(() => {
    const list = activeLoopWidths.value
    if (list.length === 0) return { available: false as const, meanAbs: 0, maxAbs: 0, maxStageM: 0 }
    const absWidths = list.map((item) => Math.abs(item.widthM3s))
    const maxIndex = absWidths.indexOf(Math.max(...absWidths))
    return {
      available: true as const,
      meanAbs: Number((absWidths.reduce((sum, value) => sum + value, 0) / absWidths.length).toFixed(1)),
      maxAbs: Number(absWidths[maxIndex].toFixed(1)),
      maxStageM: list[maxIndex].stageM
    }
  })

  /** 查找点据所属支线拟合 */
  function branchFitOf(rating: Rating, source: RatingFitResult[] = allFits.value): RatingFitResult | undefined {
    return findBranchFit(source, rating.stationId, rating.lineNo, normalizeTrend(rating.trend))
  }

  /** 当前定线号点据（按测次时间排列，体现涨→落过程），含所属支线曲线流量与残差 */
  const pointRows = computed(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => {
        const time = a.measuredAt.localeCompare(b.measuredAt)
        return time !== 0 ? time : a.stageM - b.stageM
      })
      .map((rating) => {
        const fit = branchFitOf(rating)
        const predicted = fit && fit.valid ? curveFlow(fit, rating.stageM) : 0
        const residualPct =
          fit && fit.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        const verdict =
          compare?.verdict ?? (Math.abs(residualPct) > deviationLimitPct.value ? '超限' : '合格')
        return { rating, fit: fit ?? null, predicted, residualPct, verdict }
      })
  )

  /** 按筛选条件过滤后的点据 */
  const filteredRatings = computed<Rating[]>(() =>
    ratings.value.filter((rating) => {
      const keyword = filter.value.keyword.trim()
      if (keyword.length > 0) {
        const haystack = `${rating.measureNo}${rating.lineNo}${stationNameOf(rating.stationId)}`
        if (!haystack.includes(keyword)) return false
      }
      if (filter.value.stationIds.length > 0 && !filter.value.stationIds.includes(rating.stationId)) return false
      if (filter.value.lineNos.length > 0 && !filter.value.lineNos.includes(rating.lineNo)) return false
      if (filter.value.verdicts.length > 0) {
        const compare = compares.value.find((item) => item.ratingId === rating.id)
        if (!compare || !filter.value.verdicts.includes(compare.verdict)) return false
      }
      return true
    })
  )

  const hasFilter = computed<boolean>(
    () =>
      filter.value.keyword.trim().length > 0 ||
      filter.value.stationIds.length > 0 ||
      filter.value.lineNos.length > 0 ||
      filter.value.verdicts.length > 0
  )

  /** 比测行：比测记录 + 点据（含支线态势）+ 测站名，导出页与分析清单消费 */
  const compareRows = computed<CompareRow[]>(() =>
    compares.value
      .map((compare) => {
        const rating = ratings.value.find((item) => item.id === compare.ratingId) ?? null
        return {
          compare,
          rating,
          stationName: rating ? stationNameOf(rating.stationId) : '点据已删除',
          lineNo: rating?.lineNo ?? '-',
          trend: rating ? normalizeTrend(rating.trend) : null
        }
      })
      .sort((a, b) => Math.abs(b.compare.deviationPct) - Math.abs(a.compare.deviationPct))
  )

  const overLimitRows = computed<CompareRow[]>(() =>
    compareRows.value.filter((row) => row.compare.verdict === '超限')
  )

  /** 定线质量派生值：平均残差与合格点占比（按有效支线统计） */
  const fitQuality = computed(() => {
    const valid = allFits.value.filter((fit) => fit.valid)
    const meanResidual = valid.length
      ? Number((valid.reduce((sum, fit) => sum + fit.meanResidualPct, 0) / valid.length).toFixed(2))
      : 0
    const total = compareRows.value.length
    const over = overLimitRows.value.length
    return {
      validLineCount: valid.length,
      meanResidualPct: meanResidual,
      compareCount: total,
      overLimitCount: over,
      qualifyRatePct: total === 0 ? 0 : Number((((total - over) / total) * 100).toFixed(1))
    }
  })

  function patchFilter(patch: Partial<RatingFilterState>): void {
    filter.value = { ...filter.value, ...patch }
  }

  function resetFilter(): void {
    filter.value = createEmptyRatingFilter()
  }

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  function setDeviationLimit(limit: number): void {
    deviationLimitPct.value = limit
  }

  /** 新点据默认态势：与同测站时间上最近的一条测次水位比较，高算涨水、低算落水 */
  function defaultTrendForNew(stationId: string, stageM: number): { trend: TrendLabel; trendSource: 'auto' } {
    const previous = ratings.value
      .filter((rating) => rating.stationId === stationId)
      .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))[0]
    const trend = previous
      ? inferTrend(previous.stageM, stageM, normalizeTrend(previous.trend))
      : inferTrend(null, stageM)
    return { trend, trendSource: 'auto' }
  }

  async function createRating(
    payload: Omit<Rating, 'id' | 'createdAt' | 'updatedAt' | 'trend' | 'trendSource'> & {
      trend?: TrendLabel
      trendSource?: 'auto' | 'manual'
    }
  ): Promise<Rating> {
    const now = Date.now()
    const fallback = defaultTrendForNew(payload.stationId, payload.stageM)
    const row: Rating = {
      ...payload,
      trend: payload.trend ? normalizeTrend(payload.trend) : fallback.trend,
      trendSource: payload.trendSource ?? fallback.trendSource,
      id: createId('rat'),
      createdAt: now,
      updatedAt: now
    }
    await db.ratings.put(row)
    return row
  }

  async function updateRating(id: string, patch: Partial<Rating>): Promise<void> {
    await db.ratings.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  /** 定线人员人工改定态势 */
  async function setManualTrend(id: string, trend: TrendLabel): Promise<void> {
    const rating = ratings.value.find((item) => item.id === id)
    if (!rating) return
    await updateRating(id, { trend: normalizeTrend(trend), trendSource: 'manual' })
    await rebuildCompares(rating.lineNo)
  }

  /** 取消人工改定，恢复为按相邻测次水位自动判定 */
  async function resetTrendToAuto(id: string): Promise<void> {
    const rating = ratings.value.find((item) => item.id === id)
    if (!rating) return
    const working = ratings.value.map((item) =>
      item.id === id ? { ...item, trendSource: 'auto' as const } : item
    )
    const refreshed = refreshAutoTrends(working)
    const trend = refreshed.get(id) ?? normalizeTrend(rating.trend)
    await updateRating(id, { trend, trendSource: 'auto' })
    await rebuildCompares(rating.lineNo)
  }

  async function removeRating(id: string): Promise<void> {
    const rating = ratings.value.find((item) => item.id === id)
    await db.transaction('rw', [db.ratings, db.compares], async () => {
      await db.compares.where('ratingId').equals(id).delete()
      await db.ratings.delete(id)
    })
    if (rating) await rebuildCompares(rating.lineNo)
  }

  /**
   * 按最新水位 / 时间数据刷新自动态势分组（人工改定的不动），逐支重新定线，
   * 再生成 / 刷新比测记录：曲线流量取点据所属支线的拟合值，偏差超限时自动挂红。
   * 支线不足 3 点时该支不定线，曲线流量回退为实测流量（偏差 0）。
   * 直接从 IndexedDB 读取最新点据，避免新增 / 编辑后 liveQuery 尚未回推导致漏算。
   */
  async function rebuildCompares(lineNo?: string): Promise<{ count: number; fits: RatingFitResult[] }> {
    const targetLine = lineNo ?? activeLineNo.value

    // 1. 读取库内最新点据，刷新自动态势分组（manual 点据保持不动）
    const latest = await db.ratings.toArray()
    const refreshed = refreshAutoTrends(latest)
    const changed = latest.filter(
      (rating) => refreshed.has(rating.id) && refreshed.get(rating.id) !== normalizeTrend(rating.trend)
    )
    if (changed.length > 0) {
      const now = Date.now()
      await db.ratings.bulkPut(
        changed.map((rating) => ({
          ...rating,
          trend: refreshed.get(rating.id) as TrendLabel,
          trendSource: 'auto' as const,
          updatedAt: now
        }))
      )
    }

    // 2. 用刷新后的分组逐支拟合
    const working = latest.map((rating) =>
      refreshed.has(rating.id) ? { ...rating, trend: refreshed.get(rating.id) as TrendLabel } : rating
    )
    const fits = buildBranchFits(working)

    // 3. 仅刷新目标定线号下点据的比测记录（保留已有的比测人与比测时间）
    const targets = working.filter((rating) => rating.lineNo === targetLine)
    if (targets.length === 0) return { count: 0, fits }
    const existingRows = await db.compares.toArray()
    const now = Date.now()
    const rows: Compare[] = targets.map((rating) => {
      const fit = findBranchFit(fits, rating.stationId, rating.lineNo, normalizeTrend(rating.trend))
      const predicted = fit && fit.valid ? curveFlow(fit, rating.stageM) : rating.flowM3s
      const deviationPct = calcDeviationPct(rating.flowM3s, predicted)
      const existing = existingRows.find((item) => item.ratingId === rating.id)
      return {
        id: existing?.id ?? createId('cmp'),
        ratingId: rating.id,
        measuredFlow: rating.flowM3s,
        curveFlow: predicted,
        deviationPct,
        verdict: judgeDeviation(deviationPct, deviationLimitPct.value),
        operator: existing?.operator ?? '林昭',
        comparedAt: existing?.comparedAt ?? rating.measuredAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
    })
    await db.compares.bulkPut(rows)
    return { count: rows.length, fits }
  }

  /** 手工登记比测记录（导出页分析清单用） */
  async function createCompare(
    payload: Omit<Compare, 'id' | 'createdAt' | 'updatedAt' | 'deviationPct' | 'verdict'> & {
      deviationPct?: number
      verdict?: Compare['verdict']
    }
  ): Promise<Compare> {
    const now = Date.now()
    const deviationPct =
      payload.deviationPct ?? calcDeviationPct(payload.measuredFlow, payload.curveFlow)
    const row: Compare = {
      ...payload,
      deviationPct,
      verdict: payload.verdict ?? judgeDeviation(deviationPct, deviationLimitPct.value),
      id: createId('cmp'),
      createdAt: now,
      updatedAt: now
    }
    await db.compares.put(row)
    return row
  }

  async function updateCompare(id: string, patch: Partial<Compare>): Promise<void> {
    await db.compares.update(id, { ...patch, updatedAt: Date.now() } as never)
  }

  async function removeCompare(id: string): Promise<void> {
    await db.compares.delete(id)
  }

  return {
    ratings,
    compares,
    stations,
    ready,
    error,
    filter,
    activeLineNo,
    deviationLimitPct,
    lineNos,
    allFits,
    activeLineFits,
    activeLineStationIds,
    loopWidths,
    activeLoopWidths,
    activeLoopSummary,
    pointRows,
    filteredRatings,
    hasFilter,
    compareRows,
    overLimitRows,
    fitQuality,
    start,
    stationNameOf,
    branchFitOf,
    defaultTrendForNew,
    patchFilter,
    resetFilter,
    setActiveLine,
    setDeviationLimit,
    createRating,
    updateRating,
    setManualTrend,
    resetTrendToAuto,
    removeRating,
    rebuildCompares,
    createCompare,
    updateCompare,
    removeCompare
  }
})
