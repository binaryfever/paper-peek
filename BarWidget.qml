import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Commons as Commons
import qs.Ui

BarWidget {
  id: root
  moduleName: "binaryfever.paper-peek"

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string statusPath: (Quickshell.env("XDG_STATE_HOME") || (home + "/.local/state")) + "/paper-peek/status"

  property string peekStatus: "off"

  implicitWidth: vertical ? barSize : Style.bar.iconSlot
  implicitHeight: vertical ? Style.bar.iconSlot : barSize

  function applyStatus(text) {
    var word = String(text || "").trim()
    if (word === "live" || word === "not-live" || word === "off") root.peekStatus = word
  }

  // Toggle, not open: a second press on the icon that opened the drawer is the
  // obvious way to close it, and the hotkey already works that way.
  function toggleDrawer() {
    IpcRegistry.call("binaryfever.paper-peek", "toggle", [])
  }

  FileView {
    path: root.statusPath
    watchChanges: true
    blockLoading: true
    printErrors: false
    onLoaded: root.applyStatus(text())
    onFileChanged: reload()
  }

  WidgetButton {
    anchors.fill: parent
    bar: root.bar
    keepSpace: true
    // The bar font's artboard glyph, nf-md-vector-square: a frame with corner
    // handles, which is what an artboard is drawn as everywhere else. Outline
    // weight, so it sits with the other status icons rather than shouting over
    // them. The three colours are the theme's own roles, the same three the
    // drawer's footer dot draws.
    text: "󰀁"
    foreground: root.peekStatus === "live"
      ? Commons.Color.accent
      : (root.peekStatus === "not-live" ? Commons.Color.urgent : Commons.Color.muted)
    // The same three words the drawer's footer draws. The bar deliberately
    // does not load the drawer's layout module for them, so a test holds these
    // literals against statusWord to stop the two drifting apart.
    tooltipText: root.peekStatus === "live" ? "Connected" : (root.peekStatus === "not-live" ? "Not connected" : "No artboard")
    onPressed: root.toggleDrawer()
  }
}
