local mp = require 'mp'
local utils = require 'mp.utils'
local msg = require 'mp.msg'

local home = os.getenv("HOME") or ""
local opts = {
    language = "ru",
    autoTranslate = false,
    vot_bin = "/usr/bin/node",
    vot_script = home .. "/.local/share/vot-mpv/vot-translate.js",
}
require('mp.options').read_options(opts, "vot")

local vot_file = nil
local translating = false
local status_timer = nil

local function cleanup()
    if vot_file then
        os.remove(vot_file)
        os.remove(vot_file .. ".status")
        vot_file = nil
    end
    if status_timer then
        status_timer:kill()
        status_timer = nil
    end
    translating = false
end

local function find_vot_track()
    local count = mp.get_property_number("track-list/count") or 0
    for i = 0, count - 1 do
        if mp.get_property("track-list/" .. i .. "/type") == "audio" then
            local title = mp.get_property("track-list/" .. i .. "/title") or ""
            if title:match("^VOT") then
                return mp.get_property_number("track-list/" .. i .. "/id")
            end
        end
    end
    return nil
end

-- Extracts YouTube videoId from URL or local filename like "Title [abc1234xyz].mkv"
local function get_youtube_url(file_path)
    local id = file_path:match("[?&]v=([A-Za-z0-9_%-]+)")
    if id then return file_path end

    id = file_path:match("%[([A-Za-z0-9_%-]+)%][^%[%]]*$")
    if id and #id == 11 then
        return "https://www.youtube.com/watch?v=" .. id
    end

    return nil
end

local function read_status()
    if not vot_file then return end
    local sf = vot_file .. ".status"
    local f = io.open(sf, "r")
    if not f then return end
    local s = f:read("*all")
    f:close()
    if s and s ~= "" then
        mp.osd_message("VOT: " .. s, 3)
    end
end

local function on_done(success, result, err)
    if status_timer then status_timer:kill(); status_timer = nil end
    translating = false

    if not success or result.status ~= 0 then
        local stderr = result and result.stderr or err or "?"
        local last_status = ""
        if vot_file then
            local f = io.open(vot_file .. ".status", "r")
            if f then last_status = f:read("*all") or ""; f:close() end
        end
        local show = last_status ~= "" and last_status or stderr:match("[^\n]*$") or "?"
        mp.osd_message("VOT: " .. show, 8)
        msg.error(stderr)
        if vot_file then
            os.remove(vot_file)
            os.remove(vot_file .. ".status")
            vot_file = nil
        end
        return
    end

    local output = (result.stdout or ""):match("^([^\n]+)")
    if output and output ~= "" then
        mp.commandv("audio-add", output, "select", "VOT " .. opts.language)
        mp.osd_message("VOT: переклад додано  ←  Ctrl+T щоб вимкнути", 5)
    else
        mp.osd_message("VOT: не отримано адресу аудіо", 5)
    end
    if vot_file then os.remove(vot_file .. ".status") end
end

local function start_translation()
    local file_path = mp.get_property("path") or ""
    local url = get_youtube_url(file_path)

    if not url then
        mp.osd_message("VOT: потрібне YouTube відео або файл з [videoId] в назві", 4)
        return
    end

    if translating then
        mp.osd_message("VOT: переклад вже виконується...", 3)
        return
    end

    local old = find_vot_track()
    if old then mp.commandv("audio-remove", old) end
    cleanup()

    vot_file = "/tmp/vot_" .. os.time() .. ".mp3"
    translating = true
    mp.osd_message("VOT: запускаємо переклад...", 3)
    msg.info("Running: " .. opts.vot_bin .. " " .. opts.vot_script .. " " .. url)

    status_timer = mp.add_periodic_timer(2, read_status)

    mp.command_native_async({
        name = "subprocess",
        args = { opts.vot_bin, opts.vot_script, url, vot_file },
        capture_stdout = true,
        capture_stderr = true,
    }, on_done)
end

local function toggle()
    local track = find_vot_track()
    if track then
        mp.commandv("audio-remove", track)
        cleanup()
        mp.osd_message("VOT: переклад вимкнено", 3)
    elseif translating then
        mp.osd_message("VOT: переклад вже виконується...", 3)
    else
        start_translation()
    end
end

mp.add_key_binding(nil, "toggle", toggle)

mp.register_event("file-loaded", function()
    cleanup()
    if opts.autoTranslate then
        if get_youtube_url(mp.get_property("path") or "") then
            start_translation()
        end
    end
end)

mp.register_event("shutdown", cleanup)
