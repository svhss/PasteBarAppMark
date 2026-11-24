import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { UniqueIdentifier } from '@dnd-kit/core'
import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/tauri'
import { appWindow } from '@tauri-apps/api/window'
import { isKeyAltPressed, isKeyCtrlPressed, settingsStoreAtom } from '~/store'
import { useAtomValue } from 'jotai'
import { throttle } from 'lodash-es'
import { History, Pin, Search, X } from 'lucide-react'
import { Prism } from 'prism-react-renderer'
import { useHotkeys } from 'react-hotkeys-hook'
import { useTranslation } from 'react-i18next'
import { VariableSizeList } from 'react-window'
import InfiniteLoader from 'react-window-infinite-loader'
import useResizeObserver from 'use-resize-observer'

import mergeRefs from '~/components/atoms/merge-refs'
import ToolTip from '~/components/atoms/tooltip'
import { Box, ButtonGhost, Flex, Input, Text } from '~/components/ui'

import { clipboardHistoryStoreAtom } from '~/store/clipboardHistoryStore'
import { themeStoreAtom } from '~/store/themeStore'
import { uiStoreAtom } from '~/store/uiStore'

import {
  useFindClipboardHistory,
  useGetPinnedClipboardHistories,
  useInfiniteClipboardHistory,
} from '~/hooks/queries/use-history-items'
import {
  useCopyPasteHistoryItem,
  usePasteHistoryItem,
} from '~/hooks/use-copypaste-history-item'
import { useDebounce } from '~/hooks/use-debounce'

import { ClipboardHistoryItem } from '~/types/history'

import { ClipboardHistoryQuickPasteRow } from '../components/ClipboardHistory/ClipboardHistoryQuickPasteRow'

type QuickPasteTab = 'history' | 'pinned'

const altKeys = ['Alt', 'Meta']
const ctrlKeys = ['Control']
const keyUp = ['ArrowUp', 'Up']
const keyDown = ['ArrowDown', 'Down']
const keyLeft = ['ArrowLeft', 'Left']
const keyRight = ['ArrowRight', 'Right']
const keyPageUp = ['PageUp']
const keyPageDown = ['PageDown']
const keyEnter = ['Enter']
const keyEscape = ['Escape']
const keyHome = ['Home']
const keyEnd = ['End']
const keyTab = ['Tab']

// Estimated row height before the real height is measured
const DEFAULT_ROW_HEIGHT = 34

const loadPrismComponents = async () => {
  // @ts-expect-error - global Prism
  window.Prism = Prism

  // Load markup-templating first as it's a dependency for PHP
  // @ts-expect-error
  await import('prismjs/components/prism-markup-templating')

  await Promise.all([
    // @ts-expect-error
    import('prismjs/components/prism-json'),
    // @ts-expect-error
    import('prismjs/components/prism-java'),
    // @ts-expect-error
    import('prismjs/components/prism-c'),
    // @ts-expect-error
    import('prismjs/components/prism-css'),
    // @ts-expect-error
    import('prismjs/components/prism-csharp'),
    // @ts-expect-error
    import('prismjs/components/prism-php'),
    // @ts-expect-error
    import('prismjs/components/prism-regex'),
    // @ts-expect-error
    import('prismjs/components/prism-ruby'),
    // @ts-expect-error
    import('prismjs/components/prism-shell-session.js'),
    // @ts-expect-error
    import('prismjs/components/prism-sql'),
    // @ts-expect-error
    import('prismjs/components/prism-uri'),
    // @ts-expect-error
    import('prismjs/components/prism-yaml'),
    // @ts-expect-error
    import('prismjs/components/prism-markdown'),
    // @ts-expect-error
    import('prismjs/components/prism-dart'),
    // @ts-expect-error
    import('~/libs/prismjs/components/prism-path'),
  ])
  Prism.languages['shell'] = Prism.languages['shell-session']
}

async function invokeCopyPasteHistoryItem(
  historyId: UniqueIdentifier,
  isQuickPasteCopyOnly: boolean,
  isQuickPasteAutoClose: boolean,
  handleCopyHistoryItem: (id: UniqueIdentifier) => void,
  handlePasteHistoryItem: (id: UniqueIdentifier, delay?: number) => void
) {
  try {
    if (isQuickPasteCopyOnly) {
      handleCopyHistoryItem(historyId)
    } else {
      if (isQuickPasteAutoClose) {
        await invoke('quickpaste_hide_paste_close', { historyId })
      } else {
        handlePasteHistoryItem(historyId, 0)
      }
    }
  } catch (error) {
    console.error('Error copying/pasting history item:', error)
  }
}

function matchesSearch(item: ClipboardHistoryItem, term: string) {
  return (
    (item.value ?? '').toLowerCase().includes(term) ||
    (item.title ?? '').toLowerCase().includes(term)
  )
}

export default function ClipboardHistoryQuickPastePage() {
  const [savingItem, setSavingItem] = useState<UniqueIdentifier | null>(null)
  const [isShowSearch, setIsShowSearch] = useState(false)
  const [activeTab, setActiveTab] = useState<QuickPasteTab>('history')
  const isPinnedTab = activeTab === 'pinned'

  const {
    isAutoPreviewLinkCardsEnabled,
    isAutoGenerateLinkCardsEnabled,
    isQuickPasteCopyOnly,
    isQuickPasteAutoClose,
    isSingleClickToCopyPaste,
    isSingleClickKeyboardFocus,
    isSingleClickToCopyPasteQuickWindow,
    historyPreviewLineLimit,
  } = useAtomValue(settingsStoreAtom)

  const historyListSimpleBarRef = useRef<HTMLDivElement | null>(null)

  const [brokenImageItems, setBrokenImageItems] = useState<UniqueIdentifier[]>([])
  const [expandedItems, setExpandedItems] = useState<UniqueIdentifier[]>([])
  const [wrappedTextItems, setWrappedTextItems] = useState<UniqueIdentifier[]>([])
  const { setIsScrolling, isScrolling, isWindows, setReturnRoute } =
    useAtomValue(uiStoreAtom)

  const { t } = useTranslation()

  const { themeDark } = useAtomValue(themeStoreAtom)
  const { ref: listWrapperRef, height: listHeight } = useResizeObserver<HTMLDivElement>()

  const { pinnedClipboardHistory } = useGetPinnedClipboardHistories()

  const isDark = themeDark()

  // Hooks for copy and paste operations
  const [, handleCopyHistoryItem] = useCopyPasteHistoryItem({
    delay: 100,
    onCopied: () => {
      if (isQuickPasteAutoClose) {
        appWindow?.close()
      }
    },
  })

  const [, , handlePasteHistoryItem] = usePasteHistoryItem({
    delay: 100,
    onPasted: () => {
      if (isQuickPasteAutoClose) {
        appWindow?.close()
      }
    },
  })

  const onCopyHistoryItem = useCallback(
    (historyId: UniqueIdentifier) => {
      handleCopyHistoryItem(historyId)
    },
    [handleCopyHistoryItem]
  )

  const onCopyPasteHistoryItem = useCallback(
    (historyId: UniqueIdentifier) => {
      invokeCopyPasteHistoryItem(
        historyId,
        isQuickPasteCopyOnly,
        isQuickPasteAutoClose,
        handleCopyHistoryItem,
        handlePasteHistoryItem
      )
    },
    [
      isQuickPasteCopyOnly,
      isQuickPasteAutoClose,
      handleCopyHistoryItem,
      handlePasteHistoryItem,
    ]
  )

  const {
    setHistoryListSimpleBar,
    scrollToTopHistoryList,
    addToClipboardHistoryIdsURLErrors,
    addToGenerateLinkMetaDataInProgress,
    removeToGenerateLinkMetaDataInProgress,
    clipboardHistoryGenerateLinkMetaDataInProgress,
    clipboardHistoryIdsURLErrors,
    generateLinkMetaData,
    removeLinkMetaData,
    clipboardHistory: allClipboardHistory,
    foundClipboardHistory,
  } = useAtomValue(clipboardHistoryStoreAtom)

  const [selectedHistoryIndex, setSelectedHistoryIndex] = useState(0)
  const [selectedPinnedIndex, setSelectedPinnedIndex] = useState(0)

  const [isPrismLoaded, setPrismLoaded] = useState(false)

  const {
    isClipboardInfiniteHistoryLoading,
    isClipboardHistoryFetchingNextPage,
    infiniteClipboardHistory,
    invalidateClipboardHistoryQuery,
    fetchNextClipboardHistoryPage,
  } = useInfiniteClipboardHistory()

  const [searchTerm, setSearchTerm] = useState('')
  const [currentTopItemTimeAgo, setCurrentTopItemTimeAgo] = useState('')

  const listRef = useRef(null)
  const rowHeights = useRef<{ [key: string]: number }>({})
  const searchHistoryInputRef = useRef<HTMLInputElement | null>(null)

  const debouncedSearchTerm = useDebounce(searchTerm, 300)

  const onScrollCallback = throttle(
    () => {
      if (!isScrolling) {
        setIsScrolling(true)
      }
    },
    300,
    { leading: true }
  )

  const hasHistorySearch = debouncedSearchTerm.length > 1

  const clipboardHistory = hasHistorySearch ? foundClipboardHistory : allClipboardHistory

  const { refetchFindClipboardHistory } = useFindClipboardHistory({
    query: debouncedSearchTerm,
  })

  const sortedPinnedHistory = useMemo(
    () =>
      [...pinnedClipboardHistory].sort(
        (a, b) => a.pinnedOrderNumber - b.pinnedOrderNumber
      ),
    [pinnedClipboardHistory]
  )

  // Pinned items are few, so the search filters them here (no backend call)
  const pinnedItems = useMemo(() => {
    const term = searchTerm.trim().toLowerCase()
    if (!term) {
      return sortedPinnedHistory
    }
    return sortedPinnedHistory.filter(item => matchesSearch(item, term))
  }, [sortedPinnedHistory, searchTerm])

  const activeItems = isPinnedTab ? pinnedItems : clipboardHistory
  const selectedIndex = isPinnedTab ? selectedPinnedIndex : selectedHistoryIndex
  const setSelectedIndex = isPinnedTab ? setSelectedPinnedIndex : setSelectedHistoryIndex

  const selectedItemId = activeItems[selectedIndex]?.historyId ?? null

  const hasActiveSearch = isPinnedTab ? searchTerm.trim().length > 0 : hasHistorySearch

  const doRefetchFindClipboardHistory = useCallback(() => {
    if (hasHistorySearch) {
      refetchFindClipboardHistory()
      setSelectedHistoryIndex(0)
    }
  }, [hasHistorySearch])

  const pasteItemAtIndex = (index: number) => {
    const itemId = activeItems[index]?.historyId
    if (!itemId) {
      return
    }
    invokeCopyPasteHistoryItem(
      itemId,
      isQuickPasteCopyOnly,
      isQuickPasteAutoClose,
      handleCopyHistoryItem,
      handlePasteHistoryItem
    )
  }

  useHotkeys(
    [...Array(10).keys()].map(i => `ctrl+${i.toString()}`),
    e => {
      e.preventDefault()
      pasteItemAtIndex(e.key === '0' ? 9 : Number(e.key) - 1)
    },
    {
      enableOnFormTags: ['input'],
    }
  )

  useHotkeys(
    [...Array(10).keys()].map(i => `meta+${i.toString()}`),
    e => {
      e.preventDefault()
      pasteItemAtIndex(e.key === '0' ? 9 : Number(e.key) - 1)
    },
    {
      enabled: !isWindows,
      enableOnFormTags: ['input'],
    }
  )

  const toggleSearch = (e?: KeyboardEvent) => {
    e?.preventDefault()
    if (isShowSearch) {
      setSearchTerm('')
    }
    setIsShowSearch(!isShowSearch)
  }

  const switchTab = (tab?: QuickPasteTab) => {
    const nextTab = tab ?? (isPinnedTab ? 'history' : 'pinned')
    if (nextTab !== activeTab) {
      setActiveTab(nextTab)
      setCurrentTopItemTimeAgo('')
    }
  }

  const clearSearch = () => {
    setSearchTerm('')
    if (searchHistoryInputRef?.current) {
      searchHistoryInputRef.current.value = ''
      searchHistoryInputRef.current.focus()
    }
  }

  useEffect(() => {
    if (searchHistoryInputRef?.current && isShowSearch) {
      searchHistoryInputRef?.current?.focus()
      // Set cursor position to end when search is activated with initial text
      if (searchTerm.length > 0) {
        requestAnimationFrame(() => {
          searchHistoryInputRef?.current?.setSelectionRange(
            searchTerm.length,
            searchTerm.length
          )
        })
      }
    }
  }, [isShowSearch])

  useHotkeys(['ctrl+f', 'meta+f', 'ctrl+k', 'meta+k', '/'], toggleSearch)

  useEffect(() => {
    const listenToClipboardUnlisten = listen(
      'clipboard://clipboard-monitor/update',
      e => {
        if (e.payload === 'clipboard update') {
          doRefetchFindClipboardHistory()
        }
      }
    )

    return () => {
      listenToClipboardUnlisten.then(unlisten => {
        unlisten()
      })
    }
  }, [doRefetchFindClipboardHistory])

  useEffect(() => {
    const loadComponents = async () => {
      await loadPrismComponents()
    }
    setReturnRoute(location.pathname)

    loadComponents()
    setPrismLoaded(true)
  }, [])

  useEffect(() => {
    if (historyListSimpleBarRef.current) {
      setHistoryListSimpleBar(historyListSimpleBarRef)
      historyListSimpleBarRef.current.addEventListener('scroll', onScrollCallback)
    }
  }, [historyListSimpleBarRef.current])

  useEffect(() => {
    setSelectedHistoryIndex(0)
    if (hasHistorySearch) {
      refetchFindClipboardHistory()
      scrollToTopHistoryList()
    }
  }, [debouncedSearchTerm])

  useEffect(() => {
    setSelectedPinnedIndex(0)
  }, [searchTerm])

  const loadMoreClipBoardHistory = async () => {
    if (!isClipboardHistoryFetchingNextPage) {
      await fetchNextClipboardHistoryPage({ cancelRefetch: false })
    }
  }

  function getRowHeight(index: number): number {
    return rowHeights.current[index] || DEFAULT_ROW_HEIGHT
  }

  function setRowHeight(index: number, size: number) {
    // @ts-expect-error - resetAfterIndex is not in the types
    listRef.current?.resetAfterIndex && listRef.current?.resetAfterIndex(0)
    rowHeights.current = { ...rowHeights.current, [index]: size }
  }

  const setBrokenImageItem = useCallback(
    (id: UniqueIdentifier) => {
      setBrokenImageItems(prev => {
        const isSelected = prev.includes(id)
        return isSelected ? prev.filter(_id => _id !== id) : [...prev, id]
      })
    },
    [setBrokenImageItems]
  )

  const setExpanded = useCallback(
    (id: UniqueIdentifier, isExpanded: boolean) => {
      setExpandedItems(prev => {
        if (isExpanded) {
          return [...prev, id]
        } else {
          return prev.filter(item => item !== id)
        }
      })
    },
    [setExpandedItems]
  )

  const setWrapText = useCallback(
    (id: UniqueIdentifier, isWrapped: boolean) => {
      setWrappedTextItems(prev => {
        if (isWrapped) {
          return [...prev, id]
        } else {
          return prev.filter(item => item !== id)
        }
      })
    },
    [setWrappedTextItems]
  )

  function hasAltKey(event: KeyboardEvent) {
    return altKeys.includes(event.key)
  }

  function hasCtrlKey(event: KeyboardEvent) {
    return ctrlKeys.includes(event.key)
  }

  // eslint-disable-next-line sonarjs/cognitive-complexity
  async function downHandler(event: KeyboardEvent) {
    if (isScrolling) {
      setIsScrolling(false)
    }

    if (hasAltKey(event)) {
      isKeyAltPressed.value = true
    }
    if (hasCtrlKey(event)) {
      isKeyCtrlPressed.value = true
    }

    // Auto-activate search when typing letters or numbers
    if (
      !isShowSearch &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      event.key.length === 1 &&
      /^[\p{L}\p{N}]$/u.test(event.key)
    ) {
      event.preventDefault()
      setIsShowSearch(true)
      setSearchTerm(event.key)
      // Focus will be handled by the useEffect that watches isShowSearch
      return
    }

    if (keyEscape.includes(event.key)) {
      event.preventDefault()
      if (isShowSearch && searchTerm.length > 0) {
        setSearchTerm('')
      } else if (isShowSearch && searchTerm.length === 0) {
        setIsShowSearch(false)
      } else if (!isShowSearch) {
        appWindow?.close()
      }
      return
    }

    const isSearchFocused =
      isShowSearch && document.activeElement === searchHistoryInputRef?.current

    // Switch tabs: Tab / Shift+Tab always, Left / Right when the search field does not have focus
    if (keyTab.includes(event.key)) {
      event.preventDefault()
      switchTab()
      return
    }

    if (!isSearchFocused && keyLeft.includes(event.key)) {
      event.preventDefault()
      switchTab('history')
      return
    }

    if (!isSearchFocused && keyRight.includes(event.key)) {
      event.preventDefault()
      switchTab('pinned')
      return
    }

    // If search is active and input is focused, only process navigation keys
    if (
      isSearchFocused &&
      !keyUp.includes(event.key) &&
      !keyDown.includes(event.key) &&
      !keyPageUp.includes(event.key) &&
      !keyPageDown.includes(event.key) &&
      !keyEnter.includes(event.key)
    ) {
      return
    }

    const lastIndex = activeItems.length - 1

    if (keyHome.includes(event.key)) {
      event.preventDefault()
      setSelectedIndex(0)
      if (!isPinnedTab) {
        scrollToTopHistoryList()
      }
      return
    }

    if (keyEnd.includes(event.key)) {
      event.preventDefault()
      setSelectedIndex(Math.max(lastIndex, 0))
      return
    }

    if (keyUp.includes(event.key)) {
      event.preventDefault()
      setSelectedIndex(Math.max(selectedIndex - 1, 0))
      return
    }

    if (keyDown.includes(event.key)) {
      event.preventDefault()
      setSelectedIndex(Math.max(Math.min(selectedIndex + 1, lastIndex), 0))
      return
    }

    if (keyPageUp.includes(event.key)) {
      event.preventDefault()
      setSelectedIndex(Math.max(selectedIndex - 5, 0))
      return
    }

    if (keyPageDown.includes(event.key)) {
      event.preventDefault()
      setSelectedIndex(Math.max(Math.min(selectedIndex + 5, lastIndex), 0))
      return
    }

    if (keyEnter.includes(event.key)) {
      event.preventDefault()
      pasteItemAtIndex(selectedIndex)
    }
  }

  function upHandler(event: KeyboardEvent) {
    if (hasAltKey(event)) {
      isKeyAltPressed.value = false
    }
    if (hasCtrlKey(event)) {
      isKeyCtrlPressed.value = false
    }
  }

  function focusHandler() {
    isKeyAltPressed.value = false
    isKeyCtrlPressed.value = false
  }

  useEffect(() => {
    window.addEventListener('keydown', downHandler)
    window.addEventListener('keyup', upHandler)
    window.addEventListener('focus', focusHandler)

    return () => {
      window.removeEventListener('keydown', downHandler)
      window.removeEventListener('keyup', upHandler)
      window.removeEventListener('focus', focusHandler)
    }
  }, [
    activeItems,
    activeTab,
    isShowSearch,
    searchTerm,
    selectedIndex,
    isScrolling,
    isQuickPasteCopyOnly,
    isQuickPasteAutoClose,
  ])

  // Props that are the same for rows in both tabs
  const getSharedRowProps = (item: ClipboardHistoryItem) => {
    const historyId = item.historyId
    return {
      clipboard: item,
      isDark,
      isWindows,
      isScrolling,
      isKeyboardSelected: selectedItemId === historyId,
      hasClipboardHistoryURLErrors: clipboardHistoryIdsURLErrors.includes(historyId),
      hasGenerateLinkMetaDataInProgress:
        clipboardHistoryGenerateLinkMetaDataInProgress.includes(historyId),
      addToClipboardHistoryIdsURLErrors,
      addToGenerateLinkMetaDataInProgress,
      removeToGenerateLinkMetaDataInProgress,
      isLinkCardPreviewEnabled: isAutoPreviewLinkCardsEnabled,
      isAutoGenerateLinkCardsEnabled,
      generateLinkMetaData,
      removeLinkMetaData,
      showSelectHistoryItems: false,
      setSelectHistoryItem: () => {},
      onCopy: onCopyHistoryItem,
      onCopyPaste: onCopyPasteHistoryItem,
      isSaved: historyId === savingItem,
      setSavingItem,
      isDeleting: false,
      isSelected: false,
      setBrokenImageItem,
      isBrokenImage: brokenImageItems.includes(historyId),
      // Compact layout: no "x minutes ago" header between rows (time shows on hover)
      showTimeAgo: false,
      isExpanded: expandedItems.includes(historyId),
      isWrapText: wrappedTextItems.includes(historyId),
      searchTerm: !hasActiveSearch ? '' : isPinnedTab ? searchTerm : debouncedSearchTerm,
      invalidateClipboardHistoryQuery: () => {
        invalidateClipboardHistoryQuery()
        doRefetchFindClipboardHistory()
      },
      setExpanded,
      setWrapText,
      isSingleClickToCopyPaste:
        isSingleClickToCopyPaste || isSingleClickToCopyPasteQuickWindow,
      isSingleClickKeyboardFocus,
      historyPreviewLineLimit,
    }
  }

  const foundCount = isPinnedTab ? pinnedItems.length : clipboardHistory.length

  const isHistoryEmpty =
    !isClipboardInfiniteHistoryLoading &&
    infiniteClipboardHistory?.pages?.flat().length === 0

  return (
    isPrismLoaded && (
      <Box className="h-[100vh] flex flex-col bg-gray-50 dark:bg-gray-800 p-1.5 pb-1">
        {/* Tab bar, similar to the top row of the Windows clipboard panel (Win+V) */}
        <Flex className="shrink-0 items-center gap-1 mb-1">
          <Flex
            className="flex-1 gap-0.5 p-0.5 rounded-md bg-slate-200/70 dark:bg-slate-900/70"
            role="tablist"
          >
            <QuickPasteTabButton
              isActive={!isPinnedTab}
              onClick={() => switchTab('history')}
              icon={<History size={13} />}
              label={t('History', { ns: 'common' })}
            />
            <QuickPasteTabButton
              isActive={isPinnedTab}
              onClick={() => switchTab('pinned')}
              icon={<Pin size={13} />}
              label={t('Pinned', { ns: 'common' })}
              count={sortedPinnedHistory.length}
            />
          </Flex>
          <ButtonGhost
            className={`h-7 w-7 p-0 shrink-0 rounded-md ${
              isShowSearch
                ? 'bg-slate-200 dark:bg-slate-700'
                : 'hover:bg-slate-200/70 dark:hover:bg-slate-700/70'
            }`}
            title={`${t('Find in history', { ns: 'dashboard' })} (Ctrl+F)`}
            onClick={() => toggleSearch()}
          >
            <Search size={14} />
          </ButtonGhost>
        </Flex>

        {isShowSearch && (
          <SearchInput
            key="search-input"
            setSearchTerm={setSearchTerm}
            searchTerm={searchTerm}
            searchHistoryInputRef={searchHistoryInputRef}
            onClear={clearSearch}
            resultText={
              hasActiveSearch
                ? foundCount
                  ? `${foundCount < 100 ? foundCount : '100+'} ${t('found', {
                      ns: 'common',
                    })}`
                  : t('Nothing found', { ns: 'common' })
                : ''
            }
            placeholder={
              isPinnedTab
                ? `${t('Pinned', { ns: 'common' })}...`
                : `${t('Find in history', { ns: 'dashboard' })}...`
            }
          />
        )}

        <div
          ref={listWrapperRef}
          className="relative flex-1 min-h-0"
          id="quick-paste-history-list"
        >
          {isPinnedTab ? (
            pinnedItems.length > 0 ? (
              <div
                className="overflow-y-auto overflow-x-hidden pr-0.5"
                style={{ height: listHeight ?? 300 }}
              >
                {pinnedItems.map((item, index) => (
                  <ClipboardHistoryQuickPasteRow
                    key={item.historyId}
                    {...getSharedRowProps(item)}
                    isPinnedTop
                    isPinnedTopFirst={index === 0}
                    shortcutIndex={index}
                    setKeyboardSelected={id => {
                      const index = pinnedItems.findIndex(item => item.historyId === id)
                      if (index > -1) {
                        setSelectedPinnedIndex(index)
                      }
                    }}
                  />
                ))}
              </div>
            ) : (
              <EmptyMessage
                text={
                  hasActiveSearch
                    ? t('Nothing found', { ns: 'common' })
                    : t('No pinned items', { ns: 'history' })
                }
              />
            )
          ) : clipboardHistory.length > 0 || hasHistorySearch ? (
            <>
              {currentTopItemTimeAgo && (
                <Box className="top-1 absolute z-100 animate-in fade-in fade-out duration-300 flex justify-center w-full pointer-events-none">
                  <ToolTip
                    text={t('Scroll to Top', { ns: 'common' })}
                    className="animate-in fade-in fade-out duration-300"
                    isCompact
                    delayDuration={2000}
                    side="bottom"
                    asChild
                    sideOffset={10}
                  >
                    <ButtonGhost
                      className="pointer-events-auto h-5 rounded-full bg-slate-300 dark:bg-slate-600 hover:bg-slate-200 hover:dark:bg-slate-700"
                      onClick={() => {
                        scrollToTopHistoryList(true)
                      }}
                    >
                      <Text className="text-mute text-[10px] text-center px-2">
                        {currentTopItemTimeAgo}
                      </Text>
                    </ButtonGhost>
                  </ToolTip>
                </Box>
              )}

              <InfiniteLoader
                isItemLoaded={index =>
                  index < clipboardHistory.length && !!clipboardHistory[index]
                }
                threshold={10}
                itemCount={clipboardHistory.length + 1}
                loadMoreItems={loadMoreClipBoardHistory}
              >
                {({ onItemsRendered, ref }) => {
                  return (
                    <VariableSizeList
                      overscanCount={10}
                      style={{ overflowX: 'hidden' }}
                      height={listHeight ?? 300}
                      itemCount={clipboardHistory.length}
                      width="100%"
                      itemSize={getRowHeight}
                      itemKey={index =>
                        clipboardHistory[index].historyId ?? `id-${index}`
                      }
                      onItemsRendered={e => {
                        if (e.visibleStartIndex > 20) {
                          const currentTopItem = clipboardHistory[e.visibleStartIndex]
                          if (currentTopItem?.timeAgo) {
                            if (currentTopItemTimeAgo !== currentTopItem.timeAgo) {
                              setCurrentTopItemTimeAgo(currentTopItem.timeAgo)
                            }
                          } else {
                            setCurrentTopItemTimeAgo('')
                          }
                        } else if (currentTopItemTimeAgo) {
                          setCurrentTopItemTimeAgo('')
                        }
                        !debouncedSearchTerm && onItemsRendered(e)
                      }}
                      outerRef={historyListSimpleBarRef}
                      ref={mergeRefs(listRef, ref)}
                    >
                      {({ index, style }) => {
                        const clipboard = clipboardHistory[index]

                        return (
                          <ClipboardHistoryQuickPasteRow
                            key={clipboard.historyId}
                            {...getSharedRowProps(clipboard)}
                            setKeyboardSelected={id => {
                              const index = clipboardHistory.findIndex(
                                item => item.historyId === id
                              )
                              if (index > -1) {
                                setSelectedHistoryIndex(index)
                              }
                            }}
                            setRowHeight={setRowHeight}
                            timeAgo={clipboard.timeAgo}
                            index={index}
                            style={style}
                          />
                        )
                      }}
                    </VariableSizeList>
                  )
                }}
              </InfiniteLoader>
            </>
          ) : (
            isHistoryEmpty && (
              <EmptyMessage text={t('No Clipboard History', { ns: 'dashboard' })} />
            )
          )}
        </div>
      </Box>
    )
  )
}

function QuickPasteTabButton({
  isActive,
  onClick,
  icon,
  label,
  count,
}: {
  isActive: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  count?: number
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={isActive}
      tabIndex={-1}
      onClick={onClick}
      className={`flex-1 flex items-center justify-center gap-1 h-6 px-2 rounded text-xs font-medium transition-colors focus:outline-none ${
        isActive
          ? 'bg-white text-slate-900 shadow-sm dark:bg-slate-700 dark:text-slate-100'
          : 'text-slate-500 hover:bg-white/60 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200'
      }`}
    >
      {icon}
      <span className="truncate">{label}</span>
      {typeof count === 'number' && count > 0 && (
        <span
          className={`text-[10px] leading-4 px-1 rounded-full ${
            isActive
              ? 'bg-orange-200/80 text-orange-800 dark:bg-orange-900/70 dark:text-orange-200'
              : 'bg-slate-300/70 text-slate-600 dark:bg-slate-700 dark:text-slate-300'
          }`}
        >
          {count}
        </span>
      )}
    </button>
  )
}

function EmptyMessage({ text }: { text: string }) {
  return (
    <Flex className="items-center justify-center pt-6">
      <Text className="animate-in fade-in duration-600 text-slate-400 text-xs bg-slate-100 rounded-full px-3 dark:text-slate-500 dark:bg-slate-900">
        {text}
      </Text>
    </Flex>
  )
}

const SearchInput = React.memo(
  ({
    searchTerm,
    setSearchTerm,
    searchHistoryInputRef,
    onClear,
    resultText,
    placeholder,
  }: {
    searchTerm: string
    setSearchTerm: (value: string) => void
    searchHistoryInputRef: React.RefObject<HTMLInputElement>
    onClear: () => void
    resultText: string
    placeholder: string
  }) => (
    <Box className="shrink-0 flex flex-row bg-slate-100 dark:bg-slate-700 rounded-md p-0 items-center h-7 mb-1">
      <Input
        placeholder={placeholder}
        autoFocus
        key="search-history"
        type="text"
        onChange={e => {
          const newValue = e.target.value
          if (newValue !== searchTerm) {
            setSearchTerm(newValue)
          }
        }}
        value={searchTerm}
        ref={searchHistoryInputRef}
        iconLeft={<Search className="h-3.5 w-3.5" />}
        classNameInput="w-full pr-0 h-7 text-xs"
        className="h-7 text-xs ring-offset-0 bg-slate-100 dark:bg-slate-700 border-r-0 border-t-0 border-b-0"
        onKeyDown={e => {
          // Allow navigation keys, Tab and Escape to bubble up
          if (
            !keyEscape.includes(e.key) &&
            !keyUp.includes(e.key) &&
            !keyDown.includes(e.key) &&
            !keyPageUp.includes(e.key) &&
            !keyPageDown.includes(e.key) &&
            !keyEnter.includes(e.key) &&
            !keyTab.includes(e.key)
          ) {
            e.stopPropagation()
          }
        }}
      />
      {resultText && (
        <Text className="shrink-0 text-[10px] text-slate-500 dark:text-slate-400 px-1 whitespace-nowrap">
          {resultText}
        </Text>
      )}
      {searchTerm.length > 0 && (
        <button
          type="button"
          tabIndex={-1}
          className="shrink-0 h-7 w-6 flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          onClick={onClear}
        >
          <X size={13} />
        </button>
      )}
    </Box>
  )
)
