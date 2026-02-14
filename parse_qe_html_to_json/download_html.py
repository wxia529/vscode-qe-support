import requests

def download_html():
    url = "https://www.quantum-espresso.org/Doc/INPUT_PW.html"
    
    # 关键：伪装成浏览器，防止返回 403 Forbidden
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }

    print(f"正在下载 {url} ...")
    
    try:
        response = requests.get(url, headers=headers, timeout=30)
        response.raise_for_status() # 检查状态码是否为 200

        # 保存为本地文件
        filename = "input_pw.raw.html"
        with open(filename, "w", encoding="utf-8") as f:
            f.write(response.text)
            
        print(f"✅ 下载成功！已保存为: {filename}")
        print(f"📄 文件大小: {len(response.text) / 1024:.2f} KB")
        
    except Exception as e:
        print(f"❌ 下载失败: {e}")

if __name__ == "__main__":
    download_html()