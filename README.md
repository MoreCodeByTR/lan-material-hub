# 素材中转站

一个只跑在本机和局域网内的小工具，用来在手机、PC、测试机之间传递截图、视频、文本、日志、HAR、压缩包等开发素材。

- npm: https://www.npmjs.com/package/lan-material-hub
- GitHub: [MoreCodeByTR/lan-material-hub](https://github.com/MoreCodeByTR/lan-material-hub)

## 预览

### 桌面端

<img src="https://raw.githubusercontent.com/MoreCodeByTR/lan-material-hub/main/docs/images/desktop-home.png" alt="桌面端首页" width="900" />

### 移动端

<img src="https://raw.githubusercontent.com/MoreCodeByTR/lan-material-hub/main/docs/images/mobile-home.jpg" alt="移动端首页" width="260" />

### 连接信息

<img src="https://raw.githubusercontent.com/MoreCodeByTR/lan-material-hub/main/docs/images/connection-info.png" alt="连接信息" width="900" />

## 安装使用

```bash
npm install -g lan-material-hub
lan-material-hub start
```

启动后终端会显示本机地址和局域网地址。在电脑上打开 `localhost` 地址，在手机或其他设备上打开局域网地址，或者扫码进入。

服务会默认从 `7788` 端口开始尝试；如果端口被占用，会自动切换到后续可用端口。

```bash
lan-material-hub status
lan-material-hub stop
```

通过 `lan-material-hub start` 启动时，素材默认保存在 `~/.lan-material-hub/data`，更新 npm 包不会清除这里的数据。

想给当前设备设置一个容易识别的名字，可以这样启动：

```bash
LAN_MATERIAL_HUB_NICKNAME="办公 Mac" lan-material-hub start
```

也可以按需指定端口或素材保存目录：

```bash
PORT=7799 lan-material-hub start
DATA_DIR=/Users/tianrui/Desktop/material-data lan-material-hub start
```

## 能做什么

- 多文件上传，支持拖拽、文件选择、剪贴板图片粘贴
- 文本素材保存和一键复制
- React/antd 前端界面
- 可设置站点昵称
- 点击连接状态查看服务器设备和在线链接设备
- antd 图片预览，支持 PC 和移动端
- 视频、音频预览
- 任意文件下载
- PC 和手机浏览器响应式页面
- WebSocket 实时刷新，多端同时打开时自动同步
- 局域网地址和二维码入口

## 注意

这个服务默认不做登录鉴权，适合可信局域网或临时自测网络使用。不要在公共 Wi-Fi 或公网端口暴露。
