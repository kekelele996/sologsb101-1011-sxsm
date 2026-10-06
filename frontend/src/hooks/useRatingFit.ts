/**
 * useRatingFit：水位流量点据按涨落支拟合、残差与定线状态管理。
 * 被关系点据页与导出页消费；点据数据来自 ratingStore（IndexedDB 实时订阅）。
 * 同一测站按涨水支 / 落水支分别拟合，单支不足 3 个点据不做定线。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRatingStore } from '@/stores/ratingStore'
import type { Compare } from '@/types/compare'
import {
  curveFlow,
  fitPowerCurve,
  type Rating,
  type RatingFitResult,
  type RiseFall
} from '@/types/rating'

/** 曲线采样点（用于关系曲线绘制） */
export interface CurveSample {
  stageM: number
  flowM3s: number
}

/** 带残差的点据行 */
export interface RatingPointRow {
  rating: Rating
  stationName: string
  /** 所属支线曲线流量 */
  curveFlowM3s: number
  /** 相对残差（%）：(实测 - 曲线) / 实测 × 100 */
  residualPct: number
  /** 所属支线拟合结果 */
  fit: RatingFitResult | null
}

export interface UseRatingFitResult {
  ratings: Ref<Rating[]>
  compares: Ref<Compare[]>
  /** 参与定线的定线号列表 */
  lineNos: ComputedRef<string[]>
  /** 当前选中定线号 */
  activeLineNo: Ref<string>
  /** 当前定线号下两支的拟合结果 */
  branchFits: ComputedRef<{ rising: RatingFitResult | null; falling: RatingFitResult | null }>
  /** 全部定线的拟合结果（每个定线号含涨水支 / 落水支） */
  allFits: ComputedRef<RatingFitResult[]>
  /** 当前定线的点据（含残差） */
  pointRows: ComputedRef<RatingPointRow[]>
  /** 当前定线两支的曲线采样点，用于绘制曲线 */
  curveSamples: ComputedRef<{ rising: CurveSample[]; falling: CurveSample[] }>
  /** 超限点据清单 */
  overLimitRows: ComputedRef<RatingPointRow[]>
  /** 超限点据对应的比测记录 */
  overLimitCompares: ComputedRef<Compare[]>
  setActiveLine: (lineNo: string) => void
  /** 按当前点据重算两支参数并回写 store */
  refit: () => Promise<{ rising: RatingFitResult | null; falling: RatingFitResult | null }>
}

/**
 * 组合式函数：按定线号分组、按涨落支分别拟合幂函数 Q = a×(H-H0)^b，并给出逐点残差。
 */
export function useRatingFit(initialLineNo = 'A'): UseRatingFitResult {
  const ratingStore = useRatingStore()
  const { ratings, compares } = storeToRefs(ratingStore)
  const activeLineNo = ref<string>(initialLineNo)

  const lineNos = computed<string[]>(() => {
    const set = new Set<string>()
    ratings.value.forEach((rating) => set.add(rating.lineNo))
    if (set.size === 0) set.add(initialLineNo)
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  })

  const stationNameOf = (stationId: string): string => {
    const station = ratingStore.stations.find((item) => item.id === stationId)
    return station ? station.name : '未知测站'
  }

  const allFits = computed<RatingFitResult[]>(() => {
    const byLine = new Map<string, Rating[]>()
    ratings.value.forEach((rating) => {
      const list = byLine.get(rating.lineNo) ?? []
      list.push(rating)
      byLine.set(rating.lineNo, list)
    })
    const result: RatingFitResult[] = []
    byLine.forEach((list, lineNo) => {
      ;(['rising', 'falling'] as RiseFall[]).forEach((riseFall) => {
        const points = list
          .filter((rating) => rating.riseFall === riseFall)
          .map((rating) => ({ stageM: rating.stageM, flowM3s: rating.flowM3s }))
        result.push(fitPowerCurve(points, lineNo, riseFall))
      })
    })
    return result
  })

  const branchFits = computed<{ rising: RatingFitResult | null; falling: RatingFitResult | null }>(() => ({
    rising: allFits.value.find((item) => item.lineNo === activeLineNo.value && item.riseFall === 'rising') ?? null,
    falling: allFits.value.find((item) => item.lineNo === activeLineNo.value && item.riseFall === 'falling') ?? null
  }))

  const pointRows = computed<RatingPointRow[]>(() =>
    ratings.value
      .filter((rating) => rating.lineNo === activeLineNo.value)
      .sort((a, b) => a.stageM - b.stageM)
      .map((rating) => {
        const fit =
          allFits.value.find((item) => item.lineNo === rating.lineNo && item.riseFall === rating.riseFall) ?? null
        const predicted = fit?.valid ? curveFlow(fit, rating.stageM) : 0
        const residualPct =
          fit?.valid && rating.flowM3s > 0
            ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
            : 0
        return {
          rating,
          stationName: stationNameOf(rating.stationId),
          curveFlowM3s: predicted,
          residualPct,
          fit
        }
      })
  )

  function samplesOf(fit: RatingFitResult | null): CurveSample[] {
    if (!fit?.valid) return []
    const rows = pointRows.value.filter((row) => row.rating.riseFall === fit.riseFall)
    if (rows.length === 0) return []
    const stages = rows.map((row) => row.rating.stageM)
    const min = Math.min(...stages)
    const max = Math.max(...stages)
    const step = (max - min) / 12 || 0.1
    return Array.from({ length: 13 }, (_, index) => {
      const stageM = Number((min + step * index).toFixed(2))
      return { stageM, flowM3s: curveFlow(fit, stageM) }
    })
  }

  const curveSamples = computed<{ rising: CurveSample[]; falling: CurveSample[] }>(() => ({
    rising: samplesOf(branchFits.value.rising),
    falling: samplesOf(branchFits.value.falling)
  }))

  const overLimitRows = computed<RatingPointRow[]>(() => {
    const limit = ratingStore.deviationLimitPct
    return allFits.value.flatMap((fit) =>
      ratings.value
        .filter((rating) => rating.lineNo === fit.lineNo && rating.riseFall === fit.riseFall)
        .map((rating) => {
          const predicted = fit.valid ? curveFlow(fit, rating.stageM) : 0
          const residualPct =
            fit.valid && rating.flowM3s > 0
              ? Number((((rating.flowM3s - predicted) / rating.flowM3s) * 100).toFixed(2))
              : 0
          return {
            rating,
            stationName: stationNameOf(rating.stationId),
            curveFlowM3s: predicted,
            residualPct,
            fit
          }
        })
        .filter((row) => Math.abs(row.residualPct) > limit)
    )
  })

  const overLimitCompares = computed<Compare[]>(() =>
    compares.value.filter((compare) => compare.verdict === '超限')
  )

  function setActiveLine(lineNo: string): void {
    activeLineNo.value = lineNo
  }

  async function refit(): Promise<{ rising: RatingFitResult | null; falling: RatingFitResult | null }> {
    await ratingStore.rebuildCompares(activeLineNo.value)
    return branchFits.value
  }

  return {
    ratings,
    compares,
    lineNos,
    activeLineNo,
    branchFits,
    allFits,
    pointRows,
    curveSamples,
    overLimitRows,
    overLimitCompares,
    setActiveLine,
    refit
  }
}
