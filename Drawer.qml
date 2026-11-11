import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland
import qs.Commons
import qs.Commons as Commons
import qs.Ui
import "src/drawer-layout.js" as Layout

Item {
  id: root

  property bool opened: false

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string statePath: (Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")) + "/paper-peek/current.json"
  readonly property string statusPath: (Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")) + "/paper-peek/status"
  readonly property string cacheDir: Quickshell.env("PAPER_PEEK_CACHE") || (home + "/.cache/paper-peek")
  readonly property string fetchScript: (Quickshell.env("XDG_CONFIG_HOME") || (home + "/.config")) + "/omarchy/plugins/binaryfever.paper-peek/scripts/paper-fetch"
  readonly property string absentCatalog: cacheDir + "/absent"
  readonly property string settingsDir: (Quickshell.env("XDG_CONFIG_HOME") || (home + "/.config")) + "/paper-peek"
  readonly property string settingsPath: settingsDir + "/settings.json"
  property string drawerSide: "right"
  property int drawerWidth: 480
  property int refreshIntervalMs: 2000
  // A closed drawer checks at a fifteenth of the rate. See statusTimer.
  readonly property int idleStatusFactor: 15
  property string defaultMode: "drawer"
  property string paperUrl: ""
  property bool openIntoBrowser: false
  property bool settingsQueued: false
  property bool hotkeysQueued: false

  property string fileId: ""
  property string pageId: ""
  property string nodeId: ""
  property string projectName: ""
  property string pageName: ""
  property string artboardName: ""
  property var pageHold: null
  property var browserSlots: []
  property var boardSlots: []
  property int cursor: -1
  property real shotNaturalW: 0
  property real shotNaturalH: 0
  property bool zoomed: false
  property real zoomNaturalW: 0
  property real zoomNaturalH: 0
  property string imagePath: ""
  property int shotRevision: 0
  property string peekStatus: "off"
  property string view: "shot"
  property string notice: ""
  // Set from the helper's exit code, cleared by the next run that works.
  property string helperFault: ""
  property string pending: ""
  property var queued: null
  property string browseFileId: ""
  property string browseProjectName: ""

  readonly property string listedFileId: root.pageHold ? root.pageHold.fileId : root.fileId
  readonly property string listedPageId: root.pageHold ? root.pageHold.pageId : root.pageId
  readonly property bool shotHere:
    root.fileId !== "" && root.pageId !== "" && root.nodeId !== ""
    && root.fileId === root.listedFileId && root.pageId === root.listedPageId

  property bool docked: false

  readonly property string shotSource: imagePath === "" ? "" : (Util.fileUrl(imagePath) + (shotRevision > 0 ? ("?v=" + shotRevision) : ""))

  readonly property color ink: Commons.Color.popups.text
  readonly property var chrome: Layout.chrome(styleTokens())
  readonly property color inkSecondary: Qt.darker(ink, chrome.secondaryDarken)
  readonly property color inkEmpty: Qt.darker(ink, chrome.emptyDarken)
  readonly property var activeSlots: view === "shot" ? boardSlots : browserSlots
  readonly property bool canZoom: view === "shot" && imagePath !== ""
  readonly property var zoomRect: Layout.zoomFrame(
    window.width,
    window.height,
    zoomNaturalW,
    zoomNaturalH,
    chrome)
  readonly property var frame: Layout.contentFrame(
    view,
    content.width,
    content.height,
    shotHere ? shotNaturalW : 0,
    shotHere ? shotNaturalH : 0,
    chrome)
  readonly property var headerCopy: Layout.drawerHeader(headerInput())
  // A helper that will not run outranks a notice from one that did, because
  // every other line in the drawer is then describing a cache that cannot be
  // refreshed, and the reader is owed the reason.
  readonly property string noticeLine: root.helperFault !== "" ? root.helperFault : root.notice
  // What the footer is entitled to claim, which is nothing while the helper
  // that would check is the thing that is broken.
  readonly property string shownStatus: Layout.shownStatus(root.peekStatus, root.helperFault)

  // Changing the interval restarts the countdown, so without this the dot
  // would hold whatever the idle rate last saw for a further two seconds, in
  // front of the one person who is looking at it.
  onOpenedChanged: if (root.opened) root.probeStatus()
  onDockedChanged: if (root.docked) root.probeStatus()

  onListedFileIdChanged: boardSlots = []
  onListedPageIdChanged: boardSlots = []
  onActiveSlotsChanged: {
    if (regionList) regionList.contentY = 0
  }

  function styleTokens() {
    return {
      rowPaddingX: Style.spacing.rowPaddingX,
      body: Style.font.body,
      lg: Style.spacing.lg,
      sm: Style.spacing.sm,
      controlHeight: Style.spacing.controlHeight,
      hairline: Style.spacing.hairline,
      captionHeight: captionProbe.implicitHeight,
      badgeSize: badgeProbe.implicitHeight,
      popupRowHeight: Style.spacing.popupRowHeight
    }
  }

  function headerInput() {
    var hold = root.pageHold
    return {
      view: root.view,
      shotHere: root.shotHere,
      holding: hold !== null,
      projectName: root.projectName,
      projectId: root.fileId,
      pageName: root.pageName,
      pageId: root.pageId,
      browseProject: root.browseProjectName,
      browseFileId: root.browseFileId,
      catalogArtboard: Layout.artboardLabel(root.boardSlots, root.nodeId),
      memoryArtboard: root.artboardName,
      holdProject: hold && hold.projectName ? hold.projectName : "",
      holdPage: hold && hold.pageName ? hold.pageName : ""
    }
  }

  function dotColor(status) {
    var role = Layout.statusDot(status)
    if (role === "accent") return Commons.Color.accent
    if (role === "urgent") return Commons.Color.urgent
    return Commons.Color.muted
  }

  function runAction(id) {
    if (id === "back") root.back()
    else if (id === "zoom") root.enterZoom()
    else if (id === "browse") root.showBrowser()
    else if (id === "refresh") root.refreshBrowse()
  }

  function activateSlot(index) {
    var slot = root.activeSlots[index]
    if (!slot) return
    if (root.view !== "shot" && Layout.classify(slot).selectable) root.cursor = index
    var act = Layout.activation(slot, root.browseProjectName)
    if (act.type === "pages") {
      root.notice = ""
      root.show({ kind: "pages", fileId: act.fileId, projectName: act.projectName })
      return
    }
    if (act.type === "page") {
      root.show({
        kind: "page",
        fileId: act.fileId,
        pageId: act.pageId,
        projectName: act.projectName,
        pageName: act.pageName
      })
      return
    }
    if (act.type === "remember") root.rememberPlace(act.fileId, act.pageId, act.nodeId)
  }

  // The big view reads the JPEG already on disk, so there is no Paper call
  // here and no state to save. Leaving it puts the drawer back as it was.
  function enterZoom() {
    if (!root.canZoom) return
    if (!root.shown()) return
    root.zoomed = true
    Qt.callLater(function() {
      if (!root.zoomed) return
      zoomKeys.forceActiveFocus()
    })
  }

  function leaveZoom() {
    if (!root.zoomed) return
    root.zoomed = false
    root.zoomNaturalW = 0
    root.zoomNaturalH = 0
  }

  function toggleZoom() {
    if (root.zoomed) root.leaveZoom()
    else root.enterZoom()
  }

  function paneKey(event) {
    if (event.key === Qt.Key_Escape) {
      if (root.view === "shot") {
        if (root.docked) root.undock()
        else root.close("")
      } else {
        root.closeBrowser()
      }
      event.accepted = true
      return
    }
    if (event.key === Qt.Key_Space) {
      root.toggleZoom()
      event.accepted = true
      return
    }
    if (event.key === Qt.Key_Backspace) {
      root.runAction("back")
      event.accepted = true
      return
    }
    if (event.key === Qt.Key_Up || event.key === Qt.Key_Down) {
      var delta = event.key === Qt.Key_Up ? -1 : 1
      if (root.view === "shot") {
        regionList.contentY = Layout.scrollBy(
          regionList.contentY,
          delta,
          root.chrome,
          regionList.contentHeight,
          regionList.height)
      } else {
        root.cursor = Layout.moveCursor(root.activeSlots, root.cursor, delta)
        if (root.cursor >= 0) regionList.positionViewAtIndex(root.cursor, ListView.Contain)
      }
      event.accepted = true
      return
    }
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
      if (root.view === "shot") root.runAction("browse")
      else root.activateSlot(root.cursor)
      event.accepted = true
    }
  }

  // Every run of the helper passes its exit code through here, so a run that
  // works clears what a broken one said.
  function noteExit(exitCode) {
    root.helperFault = Layout.helperFault(exitCode)
  }

  function applyStatus(text) {
    var word = String(text || "").trim()
    if (word === "live" || word === "not-live" || word === "off") root.peekStatus = word
  }

  function probeStatus() {
    if (statusProbe.running) return
    statusProbe.running = true
  }

  function open(payloadJson) {
    if (docked) undock()
    stateFile.reload()
    readCurrent()
    opened = true
    notice = ""
    show({ kind: "current" })
    startCommand(["resolve"], "resolve")
  }

  function present() {
    if (root.defaultMode === "dock") {
      root.dock("")
      return
    }
    root.open("")
  }

  function shown() {
    return root.opened || root.docked
  }

  function openBrowser() {
    if (root.opened || root.docked) {
      root.showBrowser()
      return
    }
    root.openIntoBrowser = true
    if (root.defaultMode === "dock") root.dock("")
    else root.open("")
  }

  function refreshShot() {
    if (fileId === "" || nodeId === "") return
    if (shotFetch.running) return
    shotFetch.command = [fetchScript, "shot", fileId, nodeId]
    shotFetch.running = true
  }

  function watchArtboard() {
    if ((!opened && !docked) || peekStatus !== "live") return
    if (fileId === "" || nodeId === "") return
    if (watchFetch.running || shotFetch.running) return
    watchFetch.command = [fetchScript, "watch", fileId, nodeId]
    watchFetch.running = true
  }

  function close(payloadJson) {
    leaveZoom()
    opened = false
  }

  function toggle() {
    if (docked) {
      undock()
      return
    }
    if (opened) close("")
    else present()
  }

  function attachBody(toDock) {
    var next = toDock ? dockPad : surface
    if (!next) return
    if (body.parent !== next) body.parent = next
    body.anchors.fill = next
    body.anchors.margins = 0
  }

  function dock(payloadJson) {
    if (docked && dockWindow.visible) return
    opened = false
    attachBody(true)
    docked = true
    dockWindow.visible = true
    stateFile.reload()
    readCurrent()
    notice = ""
    show({ kind: "current" })
    startCommand(["resolve"], "resolve")
    Qt.callLater(function() {
      if (!docked) return
      content.forceActiveFocus()
    })
  }

  function undock() {
    if (!docked && !dockWindow.visible) return
    leaveZoom()
    attachBody(false)
    docked = false
    dockWindow.visible = false
  }

  function safeId(value) {
    if (typeof value !== "string") return ""
    return /^[A-Za-z0-9_-]+$/.test(value) ? value : ""
  }

  function parseCurrent(text) {
    var empty = {
      fileId: "",
      pageId: "",
      nodeId: "",
      projectName: "",
      pageName: "",
      artboardName: ""
    }
    if (!text) return empty
    try {
      var parsed = JSON.parse(text)
      return {
        fileId: safeId(parsed.fileId),
        pageId: safeId(parsed.pageId),
        nodeId: safeId(parsed.nodeId),
        projectName: typeof parsed.projectName === "string" ? parsed.projectName : "",
        pageName: typeof parsed.pageName === "string" ? parsed.pageName : "",
        artboardName: typeof parsed.artboardName === "string" ? parsed.artboardName : ""
      }
    } catch (e) {
      return empty
    }
  }

  function nameFor(text, listKey, id) {
    if (!text || id === "") return ""
    try {
      var parsed = JSON.parse(text)
      var list = parsed[listKey]
      if (!Array.isArray(list)) return ""
      for (var i = 0; i < list.length; i++) {
        var item = list[i]
        if (item && item.id === id && typeof item.name === "string" && item.name !== "")
          return item.name
      }
    } catch (e) {
      return ""
    }
    return ""
  }

  function readCurrent() {
    var current = parseCurrent(stateFile.text())
    fileId = current.fileId
    pageId = current.pageId
    nodeId = current.nodeId
    projectName = current.projectName
    pageName = current.pageName
    artboardName = current.artboardName
    imagePath = fileId !== "" && nodeId !== ""
      ? cacheDir + "/shots/" + fileId + "/" + nodeId + ".jpg"
      : ""
    readNames()
  }

  function readNames() {
    projectName = nameFor(projectsFile.text(), "resources", fileId)
    pageName = fileId === "" ? "" : nameFor(pagesFile.text(), "pages", pageId)
  }

  function show(target) {
    if (!target || !target.kind) return
    leaveZoom()
    if (target.kind === "projects") {
      pageHold = null
      view = "projects"
      browserSlots = []
      cursor = Layout.placeCursor([])
      startCommand(["browser", "projects"], "rows")
      return
    }
    if (target.kind === "pages") {
      pageHold = null
      browseFileId = target.fileId || ""
      browseProjectName = target.projectName || ""
      view = "pages"
      browserSlots = []
      cursor = Layout.placeCursor([])
      startCommand(["browser", "pages", target.fileId], "rows")
      return
    }
    if (target.kind === "page") {
      pageHold = {
        fileId: target.fileId,
        pageId: target.pageId,
        projectName: target.projectName || "",
        pageName: target.pageName || ""
      }
      view = "shot"
      startCommand(["artboards", target.fileId, target.pageId], "catalog")
      return
    }
    if (target.kind === "current") {
      readCurrent()
      pageHold = null
      if (fileId !== "" && nodeId !== "") {
        view = "shot"
        return
      }
      view = "projects"
      browserSlots = []
      cursor = Layout.placeCursor([])
      startCommand(["browser", "projects"], "rows")
    }
  }

  function rememberPlace(fileId, pageId, nodeId) {
    startCommand(["remember", fileId, pageId, nodeId], "remember")
  }

  function parseBoards(text) {
    if (!text) return []
    try {
      var parsed = JSON.parse(text)
      if (!parsed || !Array.isArray(parsed.artboards)) return []
      if (safeId(parsed.fileId) !== listedFileId || safeId(parsed.pageId) !== listedPageId) return null
      var kept = []
      for (var i = 0; i < parsed.artboards.length; i++) {
        var item = parsed.artboards[i]
        if (!item) continue
        var id = safeId(item.id)
        if (id === "" || typeof item.name !== "string") continue
        kept.push({ id: id, name: item.name })
      }
      return kept
    } catch (e) {
      return []
    }
  }

  function applyRows(parsed) {
    var rows = parsed && Array.isArray(parsed.rows) ? parsed.rows : []
    browserSlots = Layout.slotsFromBrowserJson(rows)
    cursor = Layout.placeCursor(browserSlots)
  }

  function startCommand(args, name) {
    if (commandFetch.running) {
      root.queued = { args: args, name: name }
      return
    }
    var command = [root.fetchScript]
    for (var i = 0; i < args.length; i++) command.push(args[i])
    root.pending = name
    root.queued = null
    commandFetch.command = command
    commandFetch.running = true
  }

  function drainCommand() {
    if (!root.queued || commandFetch.running) return
    var next = root.queued
    root.queued = null
    root.startCommand(next.args, next.name)
  }

  function finishCommand(text) {
    var name = root.pending
    root.pending = ""
    if (!root.opened && !root.docked) {
      root.openIntoBrowser = false
      return
    }
    var parsed = null
    try {
      parsed = JSON.parse(String(text || ""))
    } catch (e) {
      parsed = null
    }
    if (name === "resolve") root.applyResolve(parsed)
    else if (name === "rows") root.applyRows(parsed)
    else if (name === "remember") root.applyRemember()
    else if (name === "catalog") return
  }

  function applyResolve(parsed) {
    if (root.openIntoBrowser) {
      root.openIntoBrowser = false
      root.showBrowser()
      return
    }
    if (parsed && parsed.kind === "projects") {
      root.notice = typeof parsed.notice === "string" ? parsed.notice : ""
      root.show({ kind: "projects" })
      return
    }
    if (!parsed && (root.fileId === "" || root.nodeId === "")) {
      root.show({ kind: "projects" })
      return
    }
    root.notice = ""
    root.show({ kind: "current" })
    root.refreshShot()
  }

  function applyRemember() {
    root.notice = ""
    root.show({ kind: "current" })
    root.refreshShot()
  }

  function showBrowser() {
    root.notice = ""
    root.show({ kind: "projects" })
  }

  function refreshBrowse() {
    if (root.view === "pages" && root.browseFileId !== "") {
      root.startCommand(["browser", "pages", root.browseFileId, "--refresh"], "rows")
      return
    }
    if (root.view === "shot" && root.listedFileId !== "" && root.listedPageId !== "") {
      root.startCommand(["artboards", root.listedFileId, root.listedPageId, "--refresh"], "catalog")
      return
    }
    root.startCommand(["browser", "projects", "--refresh"], "rows")
  }

  function closeBrowser() {
    if (root.fileId !== "" && root.nodeId !== "") {
      root.show({ kind: "current" })
      return
    }
    if (root.docked) root.undock()
    else root.close("")
  }

  function back() {
    if (root.view === "shot" && root.pageHold) {
      root.show({
        kind: "pages",
        fileId: root.pageHold.fileId,
        projectName: root.pageHold.projectName || ""
      })
      return
    }
    if (root.view === "pages") {
      root.show({ kind: "projects" })
      return
    }
    root.closeBrowser()
  }

  function reloadSettings() {
    if (settingsFetch.running) {
      root.settingsQueued = true
      return
    }
    settingsFetch.running = true
  }

  function applySettingsText(text) {
    var parsed = null
    try {
      parsed = JSON.parse(String(text || ""))
    } catch (e) {
      parsed = null
    }
    if (!parsed || (parsed.drawerSide !== "left" && parsed.drawerSide !== "right")) {
      console.warn("paper-peek: settings reply was not usable")
      return
    }
    root.drawerSide = parsed.drawerSide
    if (typeof parsed.drawerWidth === "number") root.drawerWidth = parsed.drawerWidth
    if (typeof parsed.refreshIntervalMs === "number") {
      root.refreshIntervalMs = parsed.refreshIntervalMs
      if (statusTimer.running) statusTimer.restart()
      if (watchTimer.running) watchTimer.restart()
    }
    if (parsed.defaultMode === "drawer" || parsed.defaultMode === "dock")
      root.defaultMode = parsed.defaultMode
    root.paperUrl = parsed.source === "file" && typeof parsed.paperUrl === "string" ? parsed.paperUrl : ""
    var warnings = parsed.warnings
    if (warnings && warnings.length) {
      for (var i = 0; i < warnings.length; i++) console.warn("paper-peek: " + warnings[i])
    }
    root.applyHotkeys()
  }

  function applyHotkeys() {
    if (hotkeyFetch.running) {
      root.hotkeysQueued = true
      return
    }
    hotkeyFetch.running = true
  }

  function logWarnings(text) {
    var parsed = null
    try {
      parsed = JSON.parse(String(text || ""))
    } catch (e) {
      parsed = null
    }
    var warnings = parsed && parsed.warnings ? parsed.warnings : []
    for (var i = 0; i < warnings.length; i++) console.warn("paper-peek: " + warnings[i])
  }

  component CaptionProbe: PanelSectionHeader {
    text: "Recent"
    visible: false
    foreground: root.ink
    fontFamily: Style.menuFontFamily
    fontSize: Style.font.caption
  }

  component HeaderStrip: Item {
    id: headerStrip
    implicitHeight: Math.max(titleCol.implicitHeight, actionRow.implicitHeight) + root.chrome.framePadY * 2 + root.chrome.rule
    height: implicitHeight
    readonly property var cols: Layout.columns(width, root.chrome, actionRow.implicitWidth)

    Column {
      id: titleCol
      x: headerStrip.cols.textX
      y: root.chrome.framePadY
      width: headerStrip.cols.titleWidth
      spacing: root.chrome.titleGap

      Text {
        width: parent.width
        text: root.headerCopy.title
        textFormat: Text.PlainText
        maximumLineCount: 1
        wrapMode: Text.NoWrap
        elide: Text.ElideRight
        color: root.ink
        font.family: Style.menuFontFamily
        // The artboard's name is what the drawer is for, so it sits a step
        // above the rows that lead to it and two above the chrome around it.
        font.pixelSize: Style.font.heading
      }

      Text {
        width: parent.width
        visible: root.headerCopy.trail !== ""
        text: root.headerCopy.trail
        textFormat: Text.PlainText
        maximumLineCount: 1
        wrapMode: Text.NoWrap
        elide: Text.ElideRight
        color: root.inkSecondary
        font.family: Style.menuFontFamily
        font.pixelSize: Style.font.caption
      }
    }

    Row {
      id: actionRow
      height: implicitHeight
      anchors.right: parent.right
      anchors.rightMargin: root.chrome.gutter
      anchors.verticalCenter: titleCol.verticalCenter
      spacing: root.chrome.columnGap

      Repeater {
        model: Layout.headerActions(root.view, root.pageHold !== null)

        PanelActionButton {
          required property var modelData
          iconText: modelData.icon
          tooltipText: modelData.tooltip
          foreground: root.ink
          fontFamily: Style.menuFontFamily
          focusable: false
          onClicked: root.runAction(modelData.id)
        }
      }
    }

    PanelSeparator {
      anchors.bottom: parent.bottom
      width: parent.width
      foreground: root.ink
    }
  }

  component StatusLine: Item {
    id: statusLine
    height: root.chrome.footerHeight
    readonly property var cols: Layout.columns(width, root.chrome, 0)

    PanelSeparator {
      anchors.top: parent.top
      width: parent.width
      foreground: root.ink
    }

    Rectangle {
      x: statusLine.cols.textX
      width: root.chrome.dot
      height: root.chrome.dot
      radius: height / 2
      anchors.verticalCenter: parent.verticalCenter
      color: root.dotColor(root.shownStatus)
    }

    Text {
      x: statusLine.cols.textX + root.chrome.dot + root.chrome.columnGap
      width: Math.max(0, parent.width - x - root.chrome.gutter)
      text: Layout.statusWord(root.shownStatus)
      textFormat: Text.PlainText
      elide: Text.ElideRight
      maximumLineCount: 1
      anchors.verticalCenter: parent.verticalCenter
      color: root.ink
      font.family: Style.menuFontFamily
      font.pixelSize: Style.font.body
    }
  }

  component ShotStage: Item {
    clip: true
    visible: root.frame.shot !== null
    y: 0
    width: parent.width
    height: root.frame.shot ? root.frame.shot.height : 0

    Image {
      id: shot
      property string measuredSource: ""
      x: root.frame.shot ? root.frame.shot.image.x : 0
      y: root.frame.shot ? root.frame.shot.image.y : 0
      width: root.frame.shot ? root.frame.shot.image.width : 0
      height: root.frame.shot ? root.frame.shot.image.height : 0
      asynchronous: true
      cache: false
      fillMode: Image.PreserveAspectFit
      source: root.shotSource
      sourceSize.width: width > 0
        ? Math.max(1, Math.round(width * ((root.docked ? dockWindow.devicePixelRatio : window.devicePixelRatio) || 1)))
        : 0
      onStatusChanged: {
        if (status !== Image.Ready) return
        var key = String(source)
        if (key === "" || key === measuredSource) return
        if (implicitWidth <= 0 || implicitHeight <= 0) return
        root.shotNaturalW = implicitWidth
        root.shotNaturalH = implicitHeight
        measuredSource = key
      }
    }

    Text {
      anchors.centerIn: parent
      visible: root.frame.shot !== null
        && root.shotHere
        && (root.imagePath === "" || shot.status === Image.Error || shot.status === Image.Null)
      text: "No cached artboard"
      textFormat: Text.PlainText
      color: root.ink
      font.family: Style.menuFontFamily
      font.pixelSize: Style.font.body
    }

    // A click on the artboard opens it at the size of the screen. The pane's
    // margin counts as the artboard, so a near miss still opens it.
    MouseArea {
      anchors.fill: parent
      acceptedButtons: Qt.LeftButton
      cursorShape: root.canZoom ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: root.enterZoom()
    }

    // The sign of that click, on the artboard rather than in the drawer's top
    // bar. Declared after the pane's own MouseArea so it takes the click it
    // advertises.
    Rectangle {
      id: expandChip
      readonly property var badge: root.frame.shot ? root.frame.shot.badge : null
      visible: badge !== null && root.canZoom && shot.status === Image.Ready
      x: badge ? badge.x : 0
      y: badge ? badge.y : 0
      width: badge ? badge.size : 0
      height: width
      radius: Style.cornerRadius
      // The theme's popup background carries its own alpha, for the blur
      // behind a panel. Over an artboard that reads as a smudge of the design
      // underneath, and a pale artboard would swallow the glyph, so the chip
      // takes the theme's color at full alpha. The button draws its own
      // border over it: quiet at rest, the accent under the pointer, which is
      // what every other bordered control in the shell does.
      readonly property color base: Commons.Color.popups.background
      color: Qt.rgba(base.r, base.g, base.b, 1)

      PanelActionButton {
        anchors.centerIn: parent
        size: expandChip.width
        bordered: true
        iconText: Layout.actionIcon("zoom")
        tooltipText: "Expand"
        foreground: root.ink
        fontFamily: Style.menuFontFamily
        focusable: false
        onClicked: root.enterZoom()
      }
    }
  }

  component RegionList: ListView {
    y: root.frame.list.y
    width: parent.width
    height: root.frame.list.height
    clip: true
    model: root.activeSlots
    spacing: 0
    boundsBehavior: Flickable.StopAtBounds
    interactive: contentHeight > height
    keyNavigationEnabled: false
    highlightFollowsCurrentItem: false
    focus: false
    currentIndex: root.view === "shot" ? -1 : root.cursor
    delegate: SlotDelegate {}
  }

  component SlotDelegate: Item {
    id: rowItem
    required property var modelData
    required property int index
    property var slot: modelData
    property var face: Layout.classify(slot)
    property var cols: Layout.columns(ListView.view.width, root.chrome, 0)
    property var flags: Layout.rowSurface(root.view, slot, index, root.cursor, root.nodeId, root.shotHere)
    width: ListView.view.width
    height: Layout.slotHeight(slot, root.chrome)

    CursorSurface {
      anchors.fill: parent
      radius: 0
      visible: rowItem.face.selectable
      hasCursor: rowItem.flags.hasCursor
      current: rowItem.flags.current
      foreground: root.ink
      fill: Commons.Color.menu.selectedBackground
      currentFill: Commons.Color.menu.selectedBackground
    }

    PanelSectionHeader {
      x: rowItem.cols.textX
      width: rowItem.cols.textWidth
      height: parent.height
      visible: rowItem.face.presentation === "caption"
      text: rowItem.slot.label
      elide: Text.ElideRight
      // Replaces PanelSectionHeader's own glyph-overshoot reserve. Two gutters
      // clear that sliver many times over, so nothing gets beheaded by the clip.
      topPadding: root.chrome.captionLead
      foreground: root.ink
      fontFamily: Style.menuFontFamily
      fontSize: Style.font.caption
    }

    Text {
      x: rowItem.cols.recentLeft.x
      width: rowItem.cols.recentLeft.width
      height: parent.height
      visible: rowItem.face.presentation === "recent"
      verticalAlignment: Text.AlignVCenter
      text: rowItem.slot.label
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: (rowItem.flags.hasCursor || rowItem.flags.current) ? Commons.Color.menu.selectedText : root.ink
      font.family: Style.menuFontFamily
      font.pixelSize: Style.font.body
    }

    Text {
      x: rowItem.cols.recentRight.x
      width: rowItem.cols.recentRight.width
      height: parent.height
      visible: rowItem.face.presentation === "recent"
      verticalAlignment: Text.AlignVCenter
      horizontalAlignment: Text.AlignRight
      text: rowItem.slot.detail
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: root.inkSecondary
      font.family: Style.menuFontFamily
      font.pixelSize: Style.font.body
    }

    Text {
      x: rowItem.cols.textX
      width: Math.max(
        0,
        rowItem.cols.textWidth - (rowOrdinal.visible ? rowOrdinal.width + root.chrome.columnGap : 0))
      height: parent.height
      visible: rowItem.face.presentation === "single"
      verticalAlignment: Text.AlignVCenter
      text: rowItem.slot.label
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: (rowItem.flags.hasCursor || rowItem.flags.current) ? Commons.Color.menu.selectedText : root.ink
      font.family: Style.menuFontFamily
      font.pixelSize: Style.font.body
    }

    Text {
      id: rowOrdinal
      x: rowItem.cols.textX + rowItem.cols.textWidth - width
      width: Math.min(implicitWidth, rowItem.cols.textWidth)
      height: parent.height
      visible: rowItem.face.presentation === "single" && rowItem.slot.detail !== ""
      horizontalAlignment: Text.AlignRight
      verticalAlignment: Text.AlignVCenter
      text: rowItem.slot.detail
      textFormat: Text.PlainText
      elide: Text.ElideRight
      color: root.inkSecondary
      font.family: Style.menuFontFamily
      font.pixelSize: Style.font.caption
    }

    MouseArea {
      anchors.fill: parent
      enabled: rowItem.face.selectable
      hoverEnabled: root.view !== "shot"
      onContainsMouseChanged: {
        if (containsMouse && root.view !== "shot") root.cursor = rowItem.index
      }
      onClicked: root.activateSlot(rowItem.index)
    }
  }

  CaptionProbe {
    id: captionProbe
  }

  // Never shown. The chip on the artboard takes the theme's size for a panel
  // action, and this is what that size is measured from.
  PanelActionButton {
    id: badgeProbe
    visible: false
    fontFamily: Style.menuFontFamily
  }

  Process {
    id: shotFetch
    running: false
    environment: root.paperUrl === "" ? ({}) : ({ PAPER_MCP_URL: root.paperUrl })
    command: [root.fetchScript, "shot", "x", "x"]
    onExited: function(exitCode) {
      if (exitCode === 0) root.shotRevision += 1
    }
  }

  Process {
    id: commandFetch
    running: false
    environment: root.paperUrl === "" ? ({}) : ({ PAPER_MCP_URL: root.paperUrl })
    command: [root.fetchScript, "resolve"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.finishCommand(text)
    }
    onExited: function(exitCode) {
      root.noteExit(exitCode)
      root.drainCommand()
    }
  }

  ShellIpc {
    target: "binaryfever.paper-peek"
    function open(): string {
      root.present()
      return root.shown() ? "open" : "closed"
    }
    function browser(): string {
      root.openBrowser()
      return "ok"
    }
    function close(): string {
      root.close("")
      return "ok"
    }
    function toggle(): string {
      root.toggle()
      return root.shown() ? "open" : "closed"
    }
    function status(): string {
      return root.shownStatus
    }
    function zoom(): string {
      root.toggleZoom()
      return root.zoomed ? "open" : "closed"
    }
    function dock(): string {
      root.dock("")
      return "open"
    }
    function undock(): string {
      root.undock()
      return "closed"
    }
  }

  // Each check costs a process start and a request to Paper. While the drawer
  // is closed the bar's dot is the only reader of that answer, and nobody is
  // watching a dot the way they watch an artboard, so the check backs off to a
  // fifteenth of the rate. An open drawer puts it back on its own interval.
  Timer {
    id: statusTimer
    interval: (root.opened || root.docked)
      ? root.refreshIntervalMs
      : root.refreshIntervalMs * root.idleStatusFactor
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.probeStatus()
  }

  Timer {
    id: watchTimer
    interval: root.refreshIntervalMs
    repeat: true
    running: (root.opened || root.docked) && root.peekStatus === "live" && root.fileId !== "" && root.nodeId !== ""
    onTriggered: root.watchArtboard()
  }

  Process {
    id: watchFetch
    running: false
    environment: root.paperUrl === "" ? ({}) : ({ PAPER_MCP_URL: root.paperUrl })
    command: [root.fetchScript, "watch", "x", "x"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        if (!root.opened && !root.docked) return
        if (String(text || "").trim() === "changed") root.refreshShot()
      }
    }
  }

  Process {
    id: statusProbe
    running: false
    environment: root.paperUrl === "" ? ({}) : ({ PAPER_MCP_URL: root.paperUrl })
    command: [root.fetchScript, "status"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applyStatus(text)
    }
    onExited: function(exitCode) { root.noteExit(exitCode) }
  }

  Process {
    id: settingsFetch
    running: false
    command: [root.fetchScript, "settings"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.applySettingsText(text)
    }
    onExited: {
      if (root.settingsQueued) {
        root.settingsQueued = false
        root.reloadSettings()
        return
      }
      if (!settingsWatch.running) settingsWatch.running = true
    }
  }

  Process {
    id: hotkeyFetch
    running: false
    command: [root.fetchScript, "apply-hotkeys"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: root.logWarnings(text)
    }
    onExited: {
      if (!root.hotkeysQueued) return
      root.hotkeysQueued = false
      root.applyHotkeys()
    }
  }

  Process {
    id: settingsWatch
    running: false
    command: ["inotifywait", "-m", "-q", "-e", "close_write,create,delete,move", "--format", "%f", root.settingsDir]
    stdout: SplitParser {
      onRead: function(line) {
        if (String(line).trim() === "settings.json") root.reloadSettings()
      }
    }
    onExited: settingsWatchRetry.start()
  }

  Timer {
    id: settingsWatchRetry
    interval: 2000
    onTriggered: if (!settingsWatch.running) settingsWatch.running = true
  }

  Component.onCompleted: root.reloadSettings()

  FileView {
    path: root.statusPath
    watchChanges: true
    blockLoading: true
    printErrors: false
    onLoaded: root.applyStatus(text())
    onFileChanged: reload()
  }

  FileView {
    id: stateFile
    path: root.statePath
    watchChanges: true
    blockLoading: true
    printErrors: false
    onLoaded: root.readCurrent()
    onFileChanged: reload()
  }

  FileView {
    id: projectsFile
    path: root.cacheDir + "/projects.json"
    watchChanges: true
    blockLoading: true
    printErrors: false
    onLoaded: root.readNames()
    onFileChanged: reload()
  }

  FileView {
    id: pagesFile
    path: root.fileId === "" ? root.absentCatalog : root.cacheDir + "/pages/" + root.fileId + ".json"
    watchChanges: true
    blockLoading: true
    printErrors: false
    onLoaded: root.readNames()
    onFileChanged: reload()
  }

  FileView {
    id: catalogFile
    path: root.listedFileId === "" || root.listedPageId === ""
      ? root.absentCatalog
      : root.cacheDir + "/artboards/" + root.listedFileId + "/" + root.listedPageId + ".json"
    watchChanges: true
    blockLoading: true
    printErrors: false
    onLoaded: {
      var parsed = root.parseBoards(text())
      if (parsed === null) return
      var next = Layout.slotsFromBoards(parsed, root.listedFileId, root.listedPageId)
      if (!Layout.sameSlots(root.boardSlots, next)) root.boardSlots = next
    }
    onFileChanged: reload()
  }

  PanelWindow {
    id: window

    property real reveal: root.opened ? 1 : 0

    Behavior on reveal {
      NumberAnimation { duration: 180; easing.type: Easing.OutCubic }
    }

    visible: reveal > 0.01 || root.zoomed
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    WlrLayershell.layer: WlrLayer.Overlay
    WlrLayershell.namespace: "binaryfever-paper-peek"
    // OnDemand while the drawer is a strip, never Exclusive. Exclusive sends
    // every key to this surface for as long as the drawer is open, whatever
    // window the compositor calls active, so the editor underneath goes deaf.
    // Hyprland hands an OnDemand surface the keyboard when it maps, so Escape
    // and Space work straight after the toggle hotkey, and it gives the
    // keyboard up the moment another window takes focus.
    //
    // The big view is the one case for Exclusive. It covers the monitor, so
    // there is nothing else to type into, and Escape has to reach it. It is
    // painted in this same window rather than one of its own: a second
    // surface would have to unmap to close, and the keyboard came back from
    // that unmap belonging to no one.
    WlrLayershell.keyboardFocus: root.zoomed
      ? WlrKeyboardFocus.Exclusive
      : (root.opened ? WlrKeyboardFocus.OnDemand : WlrKeyboardFocus.None)

    screen: Quickshell.screens.length > 0 ? Quickshell.screens[0] : null
    implicitWidth: screen ? screen.width : root.drawerWidth
    implicitHeight: screen ? screen.height : root.drawerWidth
    anchors.top: true
    anchors.bottom: true
    anchors.left: true
    anchors.right: true
    // The strip alone takes input, so a click past it reaches the window
    // underneath. The big view takes the whole screen, so a click anywhere
    // closes it.
    mask: root.zoomed ? null : stripRegion

    Region {
      id: stripRegion
      item: surface
    }

    Rectangle {
      id: surface
      clip: true
      width: root.drawerWidth
      height: window.height
      x: {
        var span = width * window.reveal
        if (root.drawerSide === "left") return span - width
        var screenWidth = window.screen ? window.screen.width : width
        return screenWidth - span
      }
      color: Commons.Color.popups.background
      radius: Style.cornerRadius

      Rectangle {
        width: Math.max(1, root.chrome.rule)
        height: parent.height
        x: root.drawerSide === "left" ? parent.width - width : 0
        color: Commons.Color.popups.border
      }

      Item {
        id: body
        anchors.fill: parent
        anchors.margins: 0

        HeaderStrip {
          id: header
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.top: parent.top
        }

        Text {
          id: noticeText
          readonly property var cols: Layout.columns(parent.width, root.chrome, 0)
          x: cols.textX
          width: cols.textWidth
          anchors.top: header.bottom
          height: root.noticeLine === "" ? 0 : implicitHeight
          text: root.noticeLine
          textFormat: Text.PlainText
          wrapMode: Text.Wrap
          color: root.ink
          font.family: Style.menuFontFamily
          font.pixelSize: Style.font.body
        }

        StatusLine {
          id: footer
          anchors.left: parent.left
          anchors.right: parent.right
          anchors.bottom: parent.bottom
        }

        Item {
          id: content
          anchors.top: noticeText.bottom
          anchors.bottom: footer.top
          anchors.left: parent.left
          anchors.right: parent.right
          focus: (root.opened || root.docked) && !root.zoomed
          Keys.onPressed: function(event) { root.paneKey(event) }

          ShotStage { id: shotStage }

          PanelSeparator {
            visible: root.frame.rule > 0
            y: root.frame.shot ? root.frame.shot.height : 0
            width: parent.width
            height: root.frame.rule
            foreground: root.ink
          }

          RegionList {
            id: regionList
            visible: !Layout.showEmpty(root.view, root.activeSlots, root.pending, root.noticeLine)
          }

          Text {
            readonly property var cols: Layout.columns(parent.width, root.chrome, 0)
            visible: Layout.showEmpty(root.view, root.activeSlots, root.pending, root.noticeLine)
            anchors.verticalCenter: parent.verticalCenter
            x: cols.textX
            width: cols.textWidth
            horizontalAlignment: Text.AlignHCenter
            text: "Nothing cached yet"
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: root.inkEmpty
            font.family: Style.menuFontFamily
            font.pixelSize: Style.font.body
          }
        }
      }
    }

    // The big view, over the strip and the rest of the screen. It lives in
    // this window so that closing it hands the keyboard straight back to the
    // drawer instead of to no one.
    Item {
      anchors.fill: parent
      visible: root.zoomed
      z: 1

      Rectangle {
        // The theme's popup background carries its own alpha, for the blur
        // behind a panel. Over the desktop that reads as a window left ajar.
        // The big view is for reading the artboard, so the backdrop takes the
        // theme's color at full alpha and covers everything.
        readonly property color base: Commons.Color.popups.background
        anchors.fill: parent
        color: Qt.rgba(base.r, base.g, base.b, 1)
      }

      MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.LeftButton | Qt.RightButton
        onClicked: root.leaveZoom()
      }

      Item {
        id: zoomKeys
        anchors.fill: parent
        focus: root.zoomed
        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Escape
            || event.key === Qt.Key_Space
            || event.key === Qt.Key_Return
            || event.key === Qt.Key_Enter
            || event.key === Qt.Key_F) {
            root.leaveZoom()
            event.accepted = true
          }
        }
      }

      Image {
        id: zoomShot
        x: root.zoomRect.x
        y: root.zoomRect.y
        width: root.zoomRect.width
        height: root.zoomRect.height
        asynchronous: true
        cache: false
        // No sourceSize here. The drawer decodes the JPEG at the width it draws
        // it, which is the whole point of the small view. This one takes every
        // pixel Paper sent.
        fillMode: Image.PreserveAspectFit
        source: root.zoomed ? root.shotSource : ""
        onStatusChanged: {
          if (status !== Image.Ready) return
          if (implicitWidth <= 0 || implicitHeight <= 0) return
          root.zoomNaturalW = implicitWidth
          root.zoomNaturalH = implicitHeight
        }
      }

      Text {
        anchors.centerIn: parent
        visible: root.zoomed && (zoomShot.status === Image.Error || zoomShot.status === Image.Null)
        text: "No cached artboard"
        textFormat: Text.PlainText
        color: root.ink
        font.family: Style.menuFontFamily
        font.pixelSize: Style.font.body
      }
    }
  }

  FloatingWindow {
    id: dockWindow
    title: "Paper Peek"
    visible: false
    color: Commons.Color.popups.background
    implicitWidth: 960
    implicitHeight: 800
    minimumSize: Qt.size(360, 280)

    Item {
      id: dockPad
      anchors.fill: parent
    }

    onVisibleChanged: {
      if (visible || !root.docked) return
      root.undock()
    }
  }
}
