// Skill discovery: scan a user-specified directory for SKILL.md files.
// POST /v1/skills/scan  { "directory": "..." } -> { "skills": [{ id, name, description, content }] }

#include "server-http.h"
#include "server-common.h"

#include <string>
#include <vector>
#include <map>
#include <algorithm>
#include <cctype>
#include <cstdio>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dirent.h>
#include <sys/stat.h>
#endif

namespace {

std::string read_file(const std::string & path) {
#if defined(_WIN32)
    HANDLE h = CreateFileA(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
                           FILE_ATTRIBUTE_READONLY | FILE_FLAG_BACKUP_SEMANTICS, nullptr);
    if (h == INVALID_HANDLE_VALUE) return std::string();
    LARGE_INTEGER size;
    if (!GetFileSizeEx(h, &size)) { CloseHandle(h); return std::string(); }
    std::string out;
    out.resize(size.QuadPart);
    DWORD read = 0;
    ReadFile(h, (LPVOID)out.data(), (DWORD)size.QuadPart, &read, nullptr);
    out.resize(read);
    CloseHandle(h);
    // normalize CRLF / CR -> LF so frontmatter delimiters match regardless of origin
    out.erase(std::remove(out.begin(), out.end(), '\r'), out.end());
    return out;
#else
    FILE * f = fopen(path.c_str(), "rb");
    if (!f) return std::string();
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    std::string out;
    if (sz > 0) {
        out.resize(sz);
        fread((void *)out.data(), 1, sz, f);
    }
    fclose(f);
    // normalize CRLF / CR -> LF so frontmatter delimiters match regardless of origin
    out.erase(std::remove(out.begin(), out.end(), '\r'), out.end());
    return out;
#endif
}

std::string trim(const std::string & s) {
    size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return std::string();
    size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

// Minimal frontmatter parse: split on '---', read "key: value" lines.
std::map<std::string, std::string> parse_frontmatter(const std::string & body) {
    std::map<std::string, std::string> out;
    size_t first = body.find("---\n");
    if (first == std::string::npos) return out;
    size_t second = body.find("\n---", first + 4);
    if (second == std::string::npos) return out;
    std::string fm = body.substr(first + 4, second - (first + 4));
    size_t pos = 0;
    while (pos < fm.size()) {
        size_t nl = fm.find('\n', pos);
        std::string line = (nl == std::string::npos) ? fm.substr(pos) : fm.substr(pos, nl - pos);
        pos = (nl == std::string::npos) ? fm.size() : nl + 1;
        size_t colon = line.find(':');
        if (colon == std::string::npos) continue;
        std::string key = trim(line.substr(0, colon));
        std::string val = trim(line.substr(colon + 1));
        if (!key.empty()) out[key] = val;
    }
    return out;
}

std::string skill_id(const std::string & path) {
    std::string id = path;
    std::replace(id.begin(), id.end(), '\\', '/');
    // strip leading "./"
    if (id.rfind("./", 0) == 0) id.erase(0, 2);
    size_t dot = id.rfind(".md");
    if (dot != std::string::npos && dot == id.size() - 3) id.erase(dot);
    return id;
}

#if defined(_WIN32)
void scan_dir(const std::string & dir, std::vector<std::string> & out) {
    std::string pattern = dir;
    if (!pattern.empty() && pattern.back() != '/' && pattern.back() != '\\') pattern += "/";
    pattern += "*";
    WIN32_FIND_DATAA data;
    HANDLE h = FindFirstFileA(pattern.c_str(), &data);
    if (h == INVALID_HANDLE_VALUE) return;
    do {
        std::string name = data.cFileName;
        if (name == "." || name == "..") continue;
        std::string full = dir;
        if (!full.empty() && full.back() != '/' && full.back() != '\\') full += "/";
        full += name;
        if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) {
            scan_dir(full, out);
        } else if (name == "SKILL.md") {
            out.push_back(full);
        }
    } while (FindNextFileA(h, &data));
    FindClose(h);
}
#else
bool is_directory(const std::string & path) {
    struct stat st;
    return stat(path.c_str(), &st) == 0 && S_ISDIR(st.st_mode);
}

void scan_dir(const std::string & dir, std::vector<std::string> & out) {
    DIR * d = opendir(dir.c_str());
    if (!d) return;
    struct dirent * entry;
    while ((entry = readdir(d)) != nullptr) {
        std::string name = entry->d_name;
        if (name == "." || name == "..") continue;
        std::string full = dir;
        if (!full.empty() && full.back() != '/') full += "/";
        full += name;
        if (is_directory(full)) {
            scan_dir(full, out);
        } else if (name == "SKILL.md") {
            out.push_back(full);
        }
    }
    closedir(d);
}
#endif

} // namespace

server_http_context::handler_t make_skills_scan_handler() {
    return [](const server_http_req & req) -> server_http_res_ptr {
        json body;
        try {
            body = json::parse(req.body);
        } catch (const std::exception &) {
            auto res = std::make_unique<server_http_res>();
            res->status = 400;
            res->content_type = "application/json";
            res->data = safe_json_to_str({{"error", format_error_response("invalid JSON body", ERROR_TYPE_INVALID_REQUEST)}});
            return res;
        }
        if (!body.is_object()) {
            auto res = std::make_unique<server_http_res>();
            res->status = 400;
            res->content_type = "application/json";
            res->data = safe_json_to_str({{"error", format_error_response("request body must be a JSON object", ERROR_TYPE_INVALID_REQUEST)}});
            return res;
        }
        std::string directory = json_value(body, "directory", std::string());
        if (directory.empty()) {
            auto res = std::make_unique<server_http_res>();
            res->status = 400;
            res->content_type = "application/json";
            res->data = safe_json_to_str({{"error", format_error_response("'directory' is required", ERROR_TYPE_INVALID_REQUEST)}});
            return res;
        }

        std::vector<std::string> files;
        scan_dir(directory, files);
        std::sort(files.begin(), files.end());

        json skills = json::array();
        for (const auto & path : files) {
            std::string content = read_file(path);
            if (content.empty()) continue;
            auto fm = parse_frontmatter(content);
            std::string name = fm.count("name") ? fm.at("name") : "";
            std::string description = fm.count("description") ? fm.at("description") : "";
            if (name.empty()) {
                // fall back to parent directory name, then filename
                size_t slash = path.find_last_of("/\\");
                if (slash != std::string::npos) {
                    std::string parent = path.substr(0, slash);
                    size_t slash2 = parent.find_last_of("/\\");
                    name = (slash2 == std::string::npos) ? parent : parent.substr(slash2 + 1);
                }
                if (name.empty()) {
                    name = (slash == std::string::npos) ? path : path.substr(slash + 1);
                    size_t dot = name.rfind(".md");
                    if (dot != std::string::npos) name.erase(dot);
                }
            }
            skills.push_back({
                {"id",          skill_id(path)},
                {"name",        name},
                {"description", description},
                {"content",     content},
                {"path",        path},
            });
        }

        auto res = std::make_unique<server_http_res>();
        res->status = 200;
        res->content_type = "application/json";
        res->data = safe_json_to_str({{"skills", skills}});
        return res;
    };
}
