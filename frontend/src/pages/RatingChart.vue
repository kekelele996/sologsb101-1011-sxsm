<script setup lang="ts">
/**
 * 模块 5：/ratings 水位流量关系点据与定线（洪水绳套）
 * 点据登记涨落态势，同一测站按态势分涨水支 / 落水支分别拟合幂函数 Q=a×(H-H0)^b；
 * 关系曲线同图绘制两支，同一水位两支流量差按绳套宽度标出；比测曲线流量取所属支线拟合值。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Delete, Edit, Plus, Refresh, TrendCharts } from '@element-plus/icons-vue'
import FilterBar from '@/components/common/FilterBar.vue'
import type { FilterModel } from '@/types/filter'
import StatBadge from '@/components/common/StatBadge.vue'
import DeviationTag from '@/components/common/DeviationTag.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { useRatingStore } from '@/stores/ratingStore'
import { useStationStore } from '@/stores/stationStore'
import {
  TREND_LABELS,
  curveFlow,
  normalizeTrend,
  type Rating,
  type RatingFitResult,
  type TrendLabel
} from '@/types/rating'
import { initDatabase } from '@/utils/db'

const route = useRoute()
const router = useRouter()
const ratingStore = useRatingStore()
const stationStore = useStationStore()

const dialogVisible = ref(false)
const editingId = ref<string | null>(null)
const submitting = ref(false)
const form = reactive({
  stationId: '',
  stageM: 0,
  flowM3s: 0,
  lineNo: 'A',
  /** 涨水 / 落水 */
  trend: '涨水' as TrendLabel,
  /** auto=按相邻测次水位自动判定；manual=人工改定 */
  trendSource: 'auto' as 'auto' | 'manual',
  measureNo: '',
  measuredAt: new Date().toISOString().slice(0, 16)
})

const lineNos = computed(() => (ratingStore.lineNos.length > 0 ? ratingStore.lineNos : ['A']))

/** 当前定线号下各支线拟合结果（每测站 × 涨/落 各一支） */
const lineFits = computed<RatingFitResult[]>(() => ratingStore.activeLineFits)

/** 当前定线号点据（store 已按测次时间排序并附带所属支线拟合与残差） */
const pointRows = computed(() => ratingStore.pointRows)

/** 涨水支 / 落水支分组（同一定线号若跨多测站，按测站再区分） */
const branchCards = computed(() =>
  lineFits.value.map((fit) => ({
    fit,
    stationName: ratingStore.stationNameOf(fit.stationId),
    rows: pointRows.value.filter(
      (row) => row.rating.stationId === fit.stationId && normalizeTrend(row.rating.trend) === fit.trend
    )
  }))
)

/** 不足 3 点、未能定线的支线（明确告知哪一支不够） */
const invalidBranches = computed(() =>
  branchCards.value.filter((card) => !card.fit.valid).map((card) => card.fit.message)
)

const filterModel = computed<FilterModel>(() => ({
  keyword: ratingStore.filter.keyword,
  stationIds: ratingStore.filter.stationIds,
  lineNos: ratingStore.filter.lineNos,
  verdicts: ratingStore.filter.verdicts
}))

/** 关系曲线坐标：横轴水位、纵轴流量；两支曲线同图，绳套宽度横向标出 */
const chart = computed(() => {
  const rows = pointRows.value
  if (rows.length === 0) {
    return {
      stageMin: 0,
      stageMax: 0,
      flowMax: 0,
      curves: [] as Array<{ key: string; trend: TrendLabel; valid: boolean; points: string }>,
      points: [] as Array<{ id: string; cx: number; cy: number; trend: TrendLabel; verdict: string }>,
      widths: [] as Array<{ x: number; yRise: number; yFall: number; value: number; stageM: number }>
    }
  }
  const stages = rows.map((row) => row.rating.stageM)
  const flows = rows.map((row) => row.rating.flowM3s)
  const stageMin = Math.min(...stages)
  const stageMax = Math.max(...stages)
  const flowMax = Math.max(...flows, ...ratingStore.activeLoopWidths.flatMap((w) => [w.riseFlow, w.fallFlow])) * 1.1
  const left = 52
  const right = 328
  const top = 20
  const bottom = 190
  const toX = (stageM: number): number =>
    stageMax - stageMin < 1e-6 ? (left + right) / 2 : left + ((stageM - stageMin) / (stageMax - stageMin)) * (right - left)
  const toY = (flowM3s: number): number => bottom - (flowM3s / flowMax) * (bottom - top)

  // 每支曲线按各自拟合水位范围采样
  const curves = lineFits.value
    .filter((fit) => fit.valid)
    .map((fit) => {
      const min = Math.max(fit.stageMinM, stageMin)
      const max = Math.min(fit.stageMaxM, stageMax)
      const sampleCount = 13
      const points = Array.from({ length: sampleCount }, (_, index) => {
        const stageM = min + ((max - min) * index) / (sampleCount - 1 || 1)
        const value = curveFlow(fit, stageM)
        return `${toX(stageM).toFixed(1)},${toY(value).toFixed(1)}`
      }).join(' ')
      return { key: fit.branchKey, trend: fit.trend, valid: true, points }
    })

  const points = rows.map((row) => {
    const compare = ratingStore.compares.find((item) => item.ratingId === row.rating.id)
    const verdict =
      compare?.verdict ?? (Math.abs(row.residualPct) > ratingStore.deviationLimitPct ? '超限' : '合格')
    return {
      id: row.rating.id,
      cx: toX(row.rating.stageM),
      cy: toY(row.rating.flowM3s),
      trend: normalizeTrend(row.rating.trend),
      verdict
    }
  })

  // 绳套宽度：在当前坐标范围可见的采样水位上连接两支曲线
  const widths = ratingStore.activeLoopWidths
    .filter((w) => w.stageM >= stageMin && w.stageM <= stageMax)
    .map((w) => ({
      x: toX(w.stageM),
      yRise: toY(w.riseFlow),
      yFall: toY(w.fallFlow),
      value: Math.abs(w.widthM3s),
      stageM: w.stageM
    }))

  return { stageMin, stageMax, flowMax, curves, points, widths }
})

/** 绳套宽度标注中取值最大的一处（在图上注明数值） */
const maxWidthMark = computed(() =>
  chart.value.widths.reduce<{ x: number; yRise: number; yFall: number; value: number; stageM: number } | null>(
    (acc, item) => (acc === null || item.value > acc.value ? item : acc),
    null
  )
)

function openCreate(): void {
  editingId.value = null
  form.stationId = stationStore.currentStationId ?? stationStore.stations[0]?.id ?? ''
  form.lineNo = ratingStore.activeLineNo
  const last = pointRows.value[pointRows.value.length - 1]
  form.stageM = last ? Number((last.rating.stageM + 0.2).toFixed(2)) : 3
  form.flowM3s = last ? Number((last.rating.flowM3s * 1.2).toFixed(1)) : 50
  // 新点据默认按同测站相邻测次水位判定态势
  const guessed = ratingStore.defaultTrendForNew(form.stationId, form.stageM)
  form.trend = guessed.trend
  form.trendSource = 'auto'
  form.measureNo = `${new Date().getFullYear()}-${String(ratingStore.ratings.length + 1).padStart(3, '0')}`
  form.measuredAt = new Date().toISOString().slice(0, 16)
  dialogVisible.value = true
}

function openEdit(rating: Rating): void {
  editingId.value = rating.id
  form.stationId = rating.stationId
  form.stageM = rating.stageM
  form.flowM3s = rating.flowM3s
  form.lineNo = rating.lineNo
  form.trend = normalizeTrend(rating.trend)
  form.trendSource = rating.trendSource === 'manual' ? 'manual' : 'auto'
  form.measureNo = rating.measureNo
  form.measuredAt = rating.measuredAt.slice(0, 16)
  dialogVisible.value = true
}

/** 弹窗内切换态势来源：切到自动时立即按相邻测次水位给出建议态势 */
function syncTrendSource(source: 'auto' | 'manual'): void {
  form.trendSource = source
  if (source === 'auto') {
    form.trend = ratingStore.defaultTrendForNew(form.stationId, form.stageM).trend
  }
}

async function submitForm(): Promise<void> {
  if (!form.stationId) {
    ElMessage.warning('请选择所属测站')
    return
  }
  if (!Number.isFinite(form.stageM)) {
    ElMessage.warning('请填写水位（m）')
    return
  }
  if (!Number.isFinite(form.flowM3s) || form.flowM3s <= 0) {
    ElMessage.warning('流量应为大于 0 的数字（m³/s）')
    return
  }
  submitting.value = true
  try {
    const payload = {
      stationId: form.stationId,
      stageM: form.stageM,
      flowM3s: form.flowM3s,
      lineNo: form.lineNo.trim() || 'A',
      measureNo: form.measureNo.trim(),
      measuredAt: form.measuredAt ? new Date(form.measuredAt).toISOString() : new Date().toISOString()
    }
    if (editingId.value) {
      // 人工改定态势则随编辑一起保存；自动态势交由 rebuildCompares 按最新数据刷新
      await ratingStore.updateRating(editingId.value, {
        ...payload,
        ...(form.trendSource === 'manual'
          ? { trend: form.trend, trendSource: 'manual' }
          : { trendSource: 'auto' })
      })
      ElMessage.success('点据已更新，正在按最新数据刷新分组并重算两支定线')
    } else {
      await ratingStore.createRating({
        ...payload,
        trend: form.trend,
        trendSource: form.trendSource
      })
      ElMessage.success('点据已新增，正在分涨落支定线')
    }
    ratingStore.setActiveLine(payload.lineNo)
    dialogVisible.value = false
    await ratingStore.rebuildCompares(payload.lineNo)
  } finally {
    submitting.value = false
  }
}

async function removeRating(rating: Rating): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `删除水位 ${rating.stageM.toFixed(2)} m 处的${normalizeTrend(rating.trend)}点据将同时删除其比测记录，确认删除？`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await ratingStore.removeRating(rating.id)
  ElMessage.success('点据已删除并重算两支定线')
}

/** 表格内人工改定态势，改完立即重算所属支线 */
async function changeTrend(rating: Rating, trend: TrendLabel): Promise<void> {
  if (normalizeTrend(rating.trend) === trend && rating.trendSource === 'manual') return
  await ratingStore.setManualTrend(rating.id, trend)
  ElMessage.success(`已人工改定为${trend}支，两支定线已重算`)
}

/** 恢复为按相邻测次水位自动判定 */
async function resetTrend(rating: Rating): Promise<void> {
  await ratingStore.resetTrendToAuto(rating.id)
  ElMessage.success('已恢复为按相邻测次水位自动判定')
}

async function refit(): Promise<void> {
  // 测次水位 / 时间改动后：按最新数据刷新自动分组，再逐支定线并重算比测
  const { count, fits } = await ratingStore.rebuildCompares(ratingStore.activeLineNo)
  const lineBranches = fits.filter((fit) => fit.lineNo === ratingStore.activeLineNo)
  const valid = lineBranches.filter((fit) => fit.valid)
  const notEnough = lineBranches.filter((fit) => !fit.valid).map((fit) => fit.message)
  if (valid.length > 0) {
    const summary = valid
      .map((fit) => `${fit.trend}支 a=${fit.a}、b=${fit.b}，平均残差 ${fit.meanResidualPct}%`)
      .join('；')
    ElMessage.success(`定线完成：${summary}；刷新比测 ${count} 条${notEnough.length ? `；${notEnough.join('；')}` : ''}`)
  } else if (notEnough.length > 0) {
    ElMessage.warning(notEnough.join('；'))
  } else {
    ElMessage.warning('当前定线号下还没有点据')
  }
}

function handleLineChange(lineNo: string | number | boolean | undefined): void {
  ratingStore.setActiveLine(String(lineNo))
  void ratingStore.rebuildCompares(String(lineNo))
}

function handleFilterChange(): void {
  void router.replace({
    query: {
      ...(ratingStore.filter.keyword.trim() ? { kw: ratingStore.filter.keyword.trim() } : {}),
      ...(ratingStore.filter.stationIds.length ? { stations: ratingStore.filter.stationIds.join(',') } : {}),
      ...(ratingStore.filter.lineNos.length ? { lines: ratingStore.filter.lineNos.join(',') } : {}),
      ...(ratingStore.filter.verdicts.length ? { verdict: ratingStore.filter.verdicts.join(',') } : {})
    }
  })
}

function handleReset(): void {
  ratingStore.resetFilter()
  void router.replace({ query: {} })
}

onMounted(() => {
  if (stationStore.stations.length === 0) void initDatabase()
  const query = route.query
  ratingStore.patchFilter({
    keyword: typeof query.kw === 'string' ? query.kw : '',
    stationIds: typeof query.stations === 'string' ? query.stations.split(',') : [],
    lineNos: typeof query.lines === 'string' ? query.lines.split(',') : [],
    verdicts:
      typeof query.verdict === 'string'
        ? (query.verdict.split(',').filter((item) => item === '合格' || item === '超限') as Array<'合格' | '超限'>)
        : []
  })
  void ratingStore.rebuildCompares(ratingStore.activeLineNo)
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">水位流量关系点据与绳套定线</h2>
        <p class="gb-hint">
          点据登记涨落态势并按态势分涨水支、落水支分别拟合
          Q=a×(H-H0)^b；同一水位两支流量差为绳套宽度，比测曲线流量取所属支线拟合值，残差超
          {{ ratingStore.deviationLimitPct }}% 自动挂红。
        </p>
      </div>
      <div class="page__actions">
        <el-select
          :model-value="ratingStore.activeLineNo"
          class="page__line-select"
          @change="handleLineChange"
        >
          <el-option v-for="lineNo in lineNos" :key="lineNo" :label="`${lineNo} 线`" :value="lineNo" />
        </el-select>
        <el-button :icon="Refresh" @click="refit">重新定线</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate">新增点据</el-button>
      </div>
    </div>

    <FilterBar
      :model-value="filterModel"
      :selects="[
        {
          key: 'stationIds',
          label: '测站',
          options: stationStore.stations.map((station) => ({ label: station.name, value: station.id }))
        },
        { key: 'lineNos', label: '定线号', options: lineNos.map((lineNo) => ({ label: `${lineNo} 线`, value: lineNo })) },
        {
          key: 'verdicts',
          label: '判定',
          options: [
            { label: '合格', value: '合格' },
            { label: '超限', value: '超限' }
          ]
        }
      ]"
      keyword-placeholder="搜索测次号 / 定线号 / 测站"
      @change="handleFilterChange"
      @reset="handleReset"
    />

    <div class="gb-stats-row">
      <StatBadge
        label="涨水支点据"
        :value="pointRows.filter((row) => normalizeTrend(row.rating.trend) === '涨水').length"
        suffix="点"
        tone="success"
        icon="DataLine"
      />
      <StatBadge
        label="落水支点据"
        :value="pointRows.filter((row) => normalizeTrend(row.rating.trend) === '落水').length"
        suffix="点"
        tone="warning"
        icon="DataLine"
      />
      <StatBadge
        :label="ratingStore.activeLoopSummary.available ? '绳套宽度 均/最大' : '绳套宽度'"
        :value="ratingStore.activeLoopSummary.available ? ratingStore.activeLoopSummary.meanAbs : '—'"
        :suffix="ratingStore.activeLoopSummary.available ? `/ ${ratingStore.activeLoopSummary.maxAbs} m³/s` : '两支未齐'"
        :tone="ratingStore.activeLoopSummary.available ? 'info' : 'warning'"
        icon="ScaleToOriginal"
      />
      <StatBadge
        label="超限点据"
        :value="pointRows.filter((row) => row.verdict === '超限').length"
        suffix="点"
        :tone="pointRows.some((row) => row.verdict === '超限') ? 'danger' : 'success'"
        :icon="pointRows.some((row) => row.verdict === '超限') ? 'WarningFilled' : 'DataLine'"
      />
    </div>

    <el-alert
      v-for="card in branchCards"
      :key="card.fit.branchKey"
      :type="card.fit.valid ? 'success' : 'warning'"
      show-icon
      :closable="false"
      class="page__branch-alert"
      :title="
        card.fit.valid
          ? `${card.stationName} · ${ratingStore.activeLineNo} 线${card.fit.trend}支：Q = ${card.fit.a} × (H - ${card.fit.h0})^${card.fit.b}；样本 ${card.fit.sampleCount} 点，平均残差 ${card.fit.meanResidualPct}%，最大残差 ${card.fit.maxResidualPct}%`
          : `${card.stationName} · ${card.fit.message}`
      "
    />

    <div class="page__grid">
      <EmptyPanel
        v-if="pointRows.length === 0"
        title="该定线号下还没有关系点据"
        description="录入实测水位与流量点据后默认按相邻测次水位登记涨落态势，涨、落两支各满 3 点即可分别定线。"
        action-text="新增点据"
        @action="openCreate"
      />

      <el-table v-else :data="pointRows" border stripe class="gb-table-compact">
        <el-table-column label="态势" width="150" align="center">
          <template #default="{ row }">
            <el-select
              :model-value="normalizeTrend(row.rating.trend)"
              size="small"
              class="page__trend-select"
              :class="`is-${normalizeTrend(row.rating.trend) === '涨水' ? 'rise' : 'fall'}`"
              @change="(value: string) => changeTrend(row.rating, normalizeTrend(value))"
            >
              <el-option v-for="trend in TREND_LABELS" :key="trend" :label="trend" :value="trend" />
            </el-select>
            <el-button
              v-if="row.rating.trendSource === 'manual'"
              link
              type="primary"
              size="small"
              @click="resetTrend(row.rating)"
            >
              恢复自动
            </el-button>
            <div v-else class="gb-hint page__trend-source">自动判定</div>
          </template>
        </el-table-column>
        <el-table-column label="水位 (m)" width="100" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.stageM.toFixed(2) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="实测流量 (m³/s)" width="140" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.rating.flowM3s.toFixed(1) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="支线曲线流量 (m³/s)" width="160" align="right">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.predicted > 0 ? row.predicted.toFixed(1) : '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="残差" width="190">
          <template #default="{ row }">
            <DeviationTag :deviation-pct="row.residualPct" :verdict="row.verdict" :limit="ratingStore.deviationLimitPct" />
          </template>
        </el-table-column>
        <el-table-column label="测站 / 测次" min-width="170">
          <template #default="{ row }">
            <div>{{ row.stationName ?? ratingStore.stationNameOf(row.rating.stationId) }}</div>
            <div class="gb-hint gb-mono">{{ row.rating.measureNo || '未标记测次' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="点据时间" width="120">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.rating.measuredAt).toLocaleDateString('zh-CN') }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button size="small" :icon="Edit" @click="openEdit(row.rating)">编辑</el-button>
            <el-button size="small" type="danger" plain :icon="Delete" @click="removeRating(row.rating)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <el-card shadow="never" class="page__chart-card">
        <div class="gb-panel-title">
          <h3>{{ ratingStore.activeLineNo }} 线绳套关系曲线</h3>
          <el-icon><TrendCharts /></el-icon>
        </div>
        <svg v-if="pointRows.length > 0" viewBox="0 0 360 220" class="page__chart">
          <line x1="52" y1="190" x2="340" y2="190" stroke="#b9cfdd" />
          <line x1="52" y1="20" x2="52" y2="190" stroke="#b9cfdd" />
          <text x="6" y="24" class="gb-chart-axis">{{ chart.flowMax.toFixed(0) }}</text>
          <text x="14" y="194" class="gb-chart-axis">0</text>
          <text x="52" y="208" class="gb-chart-axis">{{ chart.stageMin.toFixed(2) }}</text>
          <text x="296" y="208" class="gb-chart-axis">{{ chart.stageMax.toFixed(2) }} m</text>

          <!-- 绳套宽度：同一水位连接两支曲线 -->
          <g v-if="chart.widths.length > 0">
            <line
              v-for="(w, index) in chart.widths"
              :key="`w-${index}`"
              :x1="w.x"
              :y1="w.yRise"
              :x2="w.x"
              :y2="w.yFall"
              stroke="#d68910"
              stroke-width="1"
              stroke-dasharray="3 2"
              opacity="0.65"
            />
            <text
              v-if="maxWidthMark"
              :x="maxWidthMark.x + 3"
              :y="(maxWidthMark.yRise + maxWidthMark.yFall) / 2"
              class="gb-chart-width"
            >
              宽 {{ maxWidthMark.value.toFixed(0) }}
            </text>
          </g>

          <!-- 涨水支（蓝）/ 落水支（橙）两条曲线 -->
          <polyline
            v-for="curve in chart.curves"
            :key="curve.key"
            :points="curve.points"
            fill="none"
            :stroke="curve.trend === '涨水' ? '#0f4c75' : '#d68910'"
            stroke-width="2"
          />
          <circle
            v-for="point in chart.points"
            :key="point.id"
            :cx="point.cx"
            :cy="point.cy"
            r="4.5"
            :fill="
              point.verdict === '超限'
                ? '#c0392b'
                : point.trend === '涨水'
                  ? '#7fd1e8'
                  : '#f5b041'
            "
            :stroke="point.verdict === '超限' ? '#7b241c' : point.trend === '涨水' ? '#0f4c75' : '#9c640c'"
          />
        </svg>
        <EmptyPanel v-else title="暂无可绘制的点据" description="录入点据后自动按涨落两支生成绳套曲线。" compact />
        <div class="page__legend">
          <span><i class="page__dot page__dot--rise" />涨水支</span>
          <span><i class="page__dot page__dot--fall" />落水支</span>
          <span><i class="page__dash" />绳套宽度（同水位两支流量差）</span>
          <span><i class="page__dot page__dot--over" />超限点据</span>
        </div>
        <el-alert
          v-for="message in invalidBranches"
          :key="message"
          type="warning"
          show-icon
          :closable="false"
          class="page__width-hint"
          :title="`${message}；该支点据不参与绳套宽度计算`"
        />
        <p v-if="ratingStore.activeLoopSummary.available" class="gb-hint">
          两支曲线水位重叠区内，绳套宽度平均 {{ ratingStore.activeLoopSummary.meanAbs }} m³/s，最大
          {{ ratingStore.activeLoopSummary.maxAbs }} m³/s（水位 {{ ratingStore.activeLoopSummary.maxStageM }} m 处）。
        </p>
      </el-card>
    </div>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑关系点据' : '新增关系点据'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="所属测站" required>
          <el-select v-model="form.stationId" placeholder="选择测站" class="page__full">
            <el-option v-for="station in stationStore.stations" :key="station.id" :label="station.name" :value="station.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="定线号" required>
          <el-input v-model="form.lineNo" placeholder="如 A / B / C" maxlength="8" />
        </el-form-item>
        <el-form-item label="涨落态势" required>
          <el-radio-group v-model="form.trend" :disabled="form.trendSource === 'auto'">
            <el-radio-button v-for="trend in TREND_LABELS" :key="trend" :value="trend">{{ trend }}</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="态势来源">
          <el-radio-group :model-value="form.trendSource" @change="syncTrendSource">
            <el-radio value="auto">按相邻测次水位自动判定</el-radio>
            <el-radio value="manual">人工改定</el-radio>
          </el-radio-group>
          <div class="gb-hint">
            自动判定：比上一条测次水位高记涨水、低记落水；测次水位或时间改动后重新定线会按最新数据刷新，人工改定的不覆盖。
          </div>
        </el-form-item>
        <el-form-item label="水位" required>
          <el-input-number v-model="form.stageM" :min="-50" :max="200" :step="0.01" :precision="2" controls-position="right" />
          <span class="page__unit">m</span>
        </el-form-item>
        <el-form-item label="流量" required>
          <el-input-number v-model="form.flowM3s" :min="0.01" :max="100000" :step="1" :precision="1" controls-position="right" />
          <span class="page__unit">m³/s</span>
        </el-form-item>
        <el-form-item label="测次号">
          <el-input v-model="form.measureNo" placeholder="如：2024-06-001" maxlength="32" />
        </el-form-item>
        <el-form-item label="点据时间">
          <el-date-picker v-model="form.measuredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm" placeholder="选择时间" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">
          {{ editingId ? '保存并重算' : '新增并定线' }}
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0f4c75;
}

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.page__line-select {
  width: 120px;
}

.page__branch-alert {
  margin: 0;
}

.page__grid {
  display: grid;
  grid-template-columns: minmax(560px, 1.5fr) minmax(340px, 1fr);
  gap: 14px;
  align-items: start;
}

.page__chart-card {
  border: 1px solid #d8e4ec;
}

.page__chart {
  width: 100%;
  height: 240px;
}

.page__trend-select {
  width: 96px;
}

.page__trend-select.is-rise :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px #2e8b57 inset;
}

.page__trend-select.is-fall :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px #d68910 inset;
}

.page__trend-source {
  margin-top: 2px;
  font-size: 11px;
}

.page__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 6px;
  font-size: 12px;
  color: #5b6b78;
}

.page__legend span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.page__dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.page__dot--rise {
  background: #7fd1e8;
  border: 1px solid #0f4c75;
}

.page__dot--fall {
  background: #f5b041;
  border: 1px solid #9c640c;
}

.page__dot--over {
  background: #c0392b;
  border: 1px solid #7b241c;
}

.page__dash {
  display: inline-block;
  width: 16px;
  border-top: 2px dashed #d68910;
}

.page__width-hint {
  margin-top: 8px;
}

.page__unit {
  margin-left: 8px;
  font-size: 12px;
  color: #8194a2;
}

.page__full {
  width: 100%;
}

@media (max-width: 1180px) {
  .page__grid {
    grid-template-columns: 1fr;
  }
}
</style>
