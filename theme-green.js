.pragma library

function greenOnLine(line) {
  var eq = line.indexOf("=")
  if (eq < 0) return ""
  var key = line.slice(0, eq).replace(/^\s+|\s+$/g, "")
  if (key !== "green") return ""
  var value = line.slice(eq + 1).replace(/^\s+|\s+$/g, "")
  if (value.charAt(0) === "\"" || value.charAt(0) === "'") value = value.slice(1)
  if (value.charAt(0) !== "#") return ""
  var body = value.slice(1, 7)
  if (body.length !== 6) return ""
  for (var i = 0; i < 6; i++) {
    var c = body.charAt(i)
    var digit = (c >= "0" && c <= "9") || (c >= "a" && c <= "f") || (c >= "A" && c <= "F")
    if (!digit) return ""
  }
  return "#" + body
}

function greenIn(raw) {
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var color = greenOnLine(lines[i])
    if (color !== "") return color
  }
  return ""
}
