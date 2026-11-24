import { useEffect, useRef } from 'react'
import { isKeyAltPressed, isKeyCtrlPressed } from '~/store'
import { Check, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Badge } from '~/components/ui'

import { Item } from '~/types/menu'

import { highlightMatchedText } from '../helpers'

// A saved clip from the pinned board, shown as one compact row in the Quick Paste window
interface QuickPasteClipRowProps {
  clip: Item
  shortcutIndex: number
  isKeyboardSelected: boolean
  isCopied: boolean
  isScrolling: boolean
  isWindows?: boolean
  searchTerm: string
  isSingleClickToCopyPaste: boolean
  isSingleClickKeyboardFocus: boolean
  onSelect: () => void
  onCopyPaste: () => void
}

function getFirstLine(value: string | null | undefined) {
  const firstLine =
    (value ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .find(line => line.trim().length > 0) ?? ''
  return firstLine.trim().slice(0, 200)
}

export function QuickPasteClipRow({
  clip,
  shortcutIndex,
  isKeyboardSelected,
  isCopied,
  isScrolling,
  isWindows,
  searchTerm,
  isSingleClickToCopyPaste,
  isSingleClickKeyboardFocus,
  onSelect,
  onCopyPaste,
}: QuickPasteClipRowProps) {
  const { t } = useTranslation()
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isKeyboardSelected && rowRef.current && !isScrolling) {
      rowRef.current.scrollIntoView({ block: 'nearest' })
    }
  }, [isKeyboardSelected, isScrolling])

  const isSecret = clip.isMasked || clip.isProtected
  // Do not show the value of secret clips or images
  const valuePreview = isSecret ? '••••••' : clip.isImage ? '' : getFirstLine(clip.value)

  const showShortcutNumber =
    (isKeyCtrlPressed.value || (isKeyAltPressed.value && !isWindows)) &&
    shortcutIndex < 10

  return (
    <div
      ref={rowRef}
      role="option"
      aria-selected={isKeyboardSelected}
      className={`relative select-none cursor-pointer rounded-md border px-2 py-1 my-0.5 flex items-center gap-2 duration-300 ${
        isCopied
          ? 'bg-green-50 border-green-600 dark:bg-green-950/80 dark:border-green-800'
          : isKeyboardSelected
            ? 'bg-blue-50 border-blue-300 shadow-sm dark:bg-amber-950 dark:border-blue-900/80'
            : 'bg-slate-50 border-orange-300/50 hover:border-orange-300/90 dark:bg-slate-900 dark:border-orange-800/60 dark:hover:border-orange-900 dark:hover:bg-slate-950'
      }`}
      onClick={() => {
        if (isSingleClickToCopyPaste && !isSingleClickKeyboardFocus) {
          onCopyPaste()
        } else {
          onSelect()
        }
      }}
      onDoubleClick={() => {
        if (!isSingleClickToCopyPaste) {
          onCopyPaste()
        }
      }}
    >
      {showShortcutNumber && (
        <Badge
          className="font-mono bg-slate-200 dark:bg-slate-700 !py-0 !px-1.5 text-[10px] shrink-0"
          variant="outline"
        >
          {shortcutIndex === 9 ? 0 : shortcutIndex + 1}
        </Badge>
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium leading-4 truncate text-slate-800 dark:text-slate-200">
          {searchTerm ? highlightMatchedText(clip.name, searchTerm) : clip.name}
        </div>
        {valuePreview && valuePreview !== clip.name && (
          <div className="text-[11px] leading-4 truncate text-slate-500 dark:text-slate-400">
            {searchTerm && !isSecret
              ? highlightMatchedText(valuePreview, searchTerm)
              : valuePreview}
          </div>
        )}
      </div>
      {isSecret && (
        <span className="shrink-0 bg-slate-200 text-slate-700 dark:bg-slate-600 dark:text-slate-300 text-[10px] leading-4 rounded-sm px-1">
          {t('Type:::Secret', { ns: 'common' })}
        </span>
      )}
      {clip.isFavorite && (
        <Star
          className="absolute right-[4px] top-[3px] text-transparent fill-orange-400 dark:fill-orange-500/60 pointer-events-none"
          size={10}
        />
      )}
      {isCopied && (
        <Check size={14} className="shrink-0 text-green-700 dark:text-green-500" />
      )}
    </div>
  )
}
