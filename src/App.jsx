import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  App,
  Button,
  Card,
  Descriptions,
  Empty,
  Form,
  Image,
  Input,
  List,
  Modal,
  QRCode,
  Segmented,
  Space,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from 'antd';
import {
  AudioOutlined,
  CopyOutlined,
  CustomerServiceOutlined,
  DeleteOutlined,
  DesktopOutlined,
  DownloadOutlined,
  FileOutlined,
  FileTextOutlined,
  InboxOutlined,
  LinkOutlined,
  PictureOutlined,
  ReloadOutlined,
  SendOutlined,
  SettingOutlined,
  UploadOutlined,
  VideoCameraOutlined,
} from '@ant-design/icons';

const { Dragger } = Upload;
const { Text, Title } = Typography;

const TYPE_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: '文件', value: 'file' },
  { label: '文本', value: 'text' },
];

const CUSTOMER_SERVICE_URL = 'lark://applink.feishu.cn/client/chat/open?openId=ou_4be3fc9e005419a4b85c8e8c5209f88a';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function isImageItem(item) {
  return item.type !== 'text' && (item.mime || '').startsWith('image/');
}

function extensionOf(fileName = '') {
  const parts = fileName.split('.');
  if (parts.length < 2) return 'file';
  return parts.pop().slice(0, 8) || 'file';
}

function itemIsVisible(item, type, query) {
  if (type !== 'all' && item.type !== type) return false;
  if (!query) return true;
  const haystack = [item.title, item.note, item.text, item.fileName, item.mime, item.source]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  return haystack.includes(query);
}

function getUploadFile(uploadFile) {
  if (uploadFile?.originFileObj instanceof File) return uploadFile.originFileObj;
  if (uploadFile instanceof File) return uploadFile;
  return null;
}

function loadBlobImage(objectUrl) {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片读取失败'));
    image.src = objectUrl;
  });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('图片转换失败'));
    }, 'image/png');
  });
}

async function convertImageBlobToPng(blob) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadBlobImage(objectUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('图片尺寸无效');

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('图片转换失败');
    context.drawImage(image, 0, 0);
    return await canvasToPngBlob(canvas);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function isLocalHostname(hostname) {
  return hostname === 'localhost'
    || hostname === '::1'
    || hostname.startsWith('127.')
    || hostname === '[::1]';
}

function pagePortSuffix() {
  return window.location.port ? `:${window.location.port}` : '';
}

function toPageAccessUrl(value) {
  try {
    const source = new URL(value, window.location.href);
    if (isLocalHostname(source.hostname) || source.hostname.startsWith('169.254.')) return null;
    return `${window.location.protocol}//${source.hostname}${pagePortSuffix()}`;
  } catch (_error) {
    return null;
  }
}

function getAccessUrls(info) {
  const urls = new Set();

  if (!isLocalHostname(window.location.hostname) && !window.location.hostname.startsWith('169.254.')) {
    urls.add(window.location.origin);
  }

  for (const url of info?.urls || []) {
    const accessUrl = toPageAccessUrl(url);
    if (accessUrl) urls.add(accessUrl);
  }

  return [...urls];
}

function browserName(userAgent) {
  if (/Edg\//.test(userAgent)) return 'Microsoft Edge';
  if (/Chrome\//.test(userAgent) && !/Chromium\//.test(userAgent)) return 'Chrome';
  if (/Firefox\//.test(userAgent)) return 'Firefox';
  if (/Safari\//.test(userAgent) && !/Chrome\//.test(userAgent)) return 'Safari';
  return 'Browser';
}

function osName(userAgent) {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (/Android/.test(userAgent)) return 'Android';
  if (/Mac OS X|Macintosh/.test(userAgent)) return 'macOS';
  if (/Windows NT/.test(userAgent)) return 'Windows';
  if (/Linux/.test(userAgent)) return 'Linux';
  return 'Unknown OS';
}

function clientDeviceInfo() {
  const userAgent = navigator.userAgent || '';
  const browser = browserName(userAgent);
  const os = osName(userAgent);
  return {
    deviceName: `${browser} on ${os}`,
    browser,
    os,
    userAgent,
    language: navigator.language || '',
    screen: `${window.screen.width}x${window.screen.height}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
    pageUrl: window.location.href,
  };
}

function displayValue(value) {
  return value == null || value === '' ? '-' : String(value);
}

export default function MaterialHubApp() {
  const { message, modal } = App.useApp();
  const [info, setInfo] = useState(null);
  const [items, setItems] = useState([]);
  const [type, setType] = useState('all');
  const [query, setQuery] = useState('');
  const [socketState, setSocketState] = useState({ label: '连接中', status: 'pending' });
  const [fileList, setFileList] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [sendingText, setSendingText] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [currentClientId, setCurrentClientId] = useState('');
  const [fileForm] = Form.useForm();
  const [textForm] = Form.useForm();
  const reconnectTimer = useRef(null);

  const visibleItems = useMemo(
    () => items.filter((item) => itemIsVisible(item, type, query)),
    [items, type, query],
  );

  const imageItems = useMemo(() => visibleItems.filter(isImageItem), [visibleItems]);

  const previewItems = useMemo(
    () =>
      imageItems.map((item) => ({
        src: item.rawUrl,
        alt: item.fileName || item.title || 'image',
        downloadUrl: item.downloadUrl,
      })),
    [imageItems],
  );

  const accessUrls = useMemo(() => getAccessUrls(info), [info]);
  const selectedUrl = accessUrls[0] || '';
  const siteTitle = info?.site?.nickname || '素材中转站';
  const linkedDevices = info?.linkedDevices || [];

  const showError = useCallback(
    (error, fallback = '操作失败') => {
      message.error(error?.message || fallback);
    },
    [message],
  );

  const copyText = useCallback(
    async (text, success = '已复制') => {
      try {
        await navigator.clipboard.writeText(text);
        message.success(success);
      } catch (_error) {
        const input = document.createElement('textarea');
        input.value = text;
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.append(input);
        input.select();
        document.execCommand('copy');
        input.remove();
        message.success(success);
      }
    },
    [message],
  );

  const copyImage = useCallback(
    async (item) => {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
        message.error('请长按图片保存/复制');
        return;
      }

      try {
        const response = await fetch(item.rawUrl);
        if (!response.ok) throw new Error('图片读取失败');

        const blob = await response.blob();
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ [blob.type || 'image/png']: blob }),
          ]);
        } catch (error) {
          if (blob.type === 'image/png') throw error;
          const pngBlob = await convertImageBlobToPng(blob);
          await navigator.clipboard.write([
            new ClipboardItem({ 'image/png': pngBlob }),
          ]);
        }
        message.success('图片已复制');
      } catch (error) {
        showError(error, '图片复制失败');
      }
    },
    [message, showError],
  );

  const upsertItems = useCallback((newItems) => {
    setItems((previous) => {
      const byId = new Map(previous.map((item) => [item.id, item]));
      for (const item of newItems) byId.set(item.id, item);
      return [...byId.values()].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    });
  }, []);

  const removeItems = useCallback((ids) => {
    const idSet = new Set(ids);
    setItems((previous) => previous.filter((item) => !idSet.has(item.id)));
  }, []);

  const loadInfo = useCallback(async () => {
    const response = await fetch('/api/info');
    if (!response.ok) throw new Error('入口信息加载失败');
    const data = await response.json();
    setInfo(data);
    return data;
  }, []);

  const loadItems = useCallback(async () => {
    const response = await fetch('/api/items');
    if (!response.ok) throw new Error('素材列表加载失败');
    const data = await response.json();
    setItems(data.items || []);
  }, []);

  const uploadFormData = useCallback(
    async (formData) => {
      const response = await fetch('/api/items', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '上传失败');
      upsertItems(data.items || []);
      return data.items || [];
    },
    [upsertItems],
  );

  const handleUpload = useCallback(async () => {
    if (fileList.length === 0) {
      message.warning('请选择文件');
      return;
    }

    const values = fileForm.getFieldsValue();
    const formData = new FormData();
    let fileCount = 0;
    for (const file of fileList) {
      const nativeFile = getUploadFile(file);
      if (!nativeFile) continue;
      formData.append('files', nativeFile);
      fileCount += 1;
    }
    if (fileCount === 0) {
      message.warning('请选择文件');
      return;
    }
    if (values.title?.trim()) formData.append('title', values.title.trim());
    if (values.note?.trim()) formData.append('note', values.note.trim());

    setUploading(true);
    try {
      await uploadFormData(formData);
      setFileList([]);
      fileForm.resetFields();
      message.success('已上传');
    } catch (error) {
      showError(error, '上传失败');
    } finally {
      setUploading(false);
    }
  }, [fileForm, fileList, message, showError, uploadFormData]);

  const handleSendText = useCallback(
    async (values) => {
      const text = values.text?.trim();
      if (!text) {
        message.warning('文本为空');
        return;
      }

      const formData = new FormData();
      formData.append('text', text);
      if (values.title?.trim()) formData.append('title', values.title.trim());

      setSendingText(true);
      try {
        await uploadFormData(formData);
        textForm.resetFields();
        message.success('已发送');
      } catch (error) {
        showError(error, '发送失败');
      } finally {
        setSendingText(false);
      }
    },
    [message, showError, textForm, uploadFormData],
  );

  const handlePasteText = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      textForm.setFieldsValue({ text });
    } catch (_error) {
      message.error('无法读取剪贴板');
    }
  }, [message, textForm]);

  const handleDelete = useCallback(
    (item) => {
      modal.confirm({
        title: '删除这条素材？',
        okText: '删除',
        okButtonProps: { danger: true },
        cancelText: '取消',
        async onOk() {
          const response = await fetch(`/api/items/${item.id}`, { method: 'DELETE' });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || '删除失败');
          removeItems([item.id]);
          message.success('已删除');
        },
      });
    },
    [message, modal, removeItems],
  );

  const openImagePreview = useCallback(
    (item) => {
      const index = imageItems.findIndex((image) => image.id === item.id);
      if (index < 0) return;
      setPreviewIndex(index);
      setPreviewOpen(true);
    },
    [imageItems],
  );

  const openConnectionInfo = useCallback(async () => {
    try {
      await loadInfo();
    } catch (error) {
      showError(error, '连接信息加载失败');
    }
    setConnectionOpen(true);
  }, [loadInfo, showError]);

  useEffect(() => {
    if (!previewOpen) return;
    if (imageItems.length === 0) {
      setPreviewOpen(false);
      return;
    }
    setPreviewIndex((current) => Math.min(current, imageItems.length - 1));
  }, [imageItems, previewOpen]);

  useEffect(() => {
    Promise.all([loadInfo(), loadItems()]).catch((error) => showError(error));
  }, [loadInfo, loadItems, showError]);

  useEffect(() => {
    let closed = false;
    let socket;

    const connectSocket = () => {
      if (closed) return;
      setSocketState({ label: '连接中', status: 'pending' });
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

      socket.addEventListener('open', () => {
        if (closed) return;
        setSocketState({ label: '已连接', status: 'online' });
        socket.send(JSON.stringify({ type: 'client:hello', client: clientDeviceInfo() }));
      });
      socket.addEventListener('error', () => {
        if (!closed) setSocketState({ label: '连接异常', status: 'offline' });
      });
      socket.addEventListener('close', () => {
        if (closed) return;
        setSocketState({ label: '已断开', status: 'offline' });
        reconnectTimer.current = window.setTimeout(connectSocket, 1800);
      });
      socket.addEventListener('message', (event) => {
        if (closed) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'hello') {
            setCurrentClientId(data.clientId || '');
            loadInfo().catch(() => undefined);
          }
          if (data.type === 'clients:updated') {
            setInfo((previous) => previous ? { ...previous, linkedDevices: data.linkedDevices || [] } : previous);
          }
          if (data.type === 'items:created') upsertItems(data.items || []);
          if (data.type === 'items:deleted') removeItems([data.id]);
          if (data.type === 'items:cleared') removeItems(data.ids || []);
        } catch (_error) {
          // Ignore non-JSON websocket messages.
        }
      });
    };

    connectSocket();

    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer.current);
      socket?.close();
    };
  }, [loadInfo, removeItems, upsertItems]);

  useEffect(() => {
    const handlePaste = async (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length === 0) return;
      event.preventDefault();

      const formData = new FormData();
      for (const file of files) formData.append('files', file);
      try {
        await uploadFormData(formData);
        message.success('已上传');
      } catch (error) {
        showError(error, '上传失败');
      }
    };

    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [message, showError, uploadFormData]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <Text className="kicker">LAN Material Hub</Text>
            <Title level={1}>{siteTitle}</Title>
          </div>
        </div>
        <Space className="status-strip" wrap>
          <button
            className={`socket-state socket-state-button ${socketState.status}`}
            type="button"
            onClick={openConnectionInfo}
          >
            {socketState.label}
          </button>
          <Button
            className="customer-service-link"
            href={CUSTOMER_SERVICE_URL}
            icon={<CustomerServiceOutlined />}
          >
            技术支持
          </Button>
        </Space>
      </header>

      <section className="workspace">
        <Card className="hub-panel" styles={{ body: { padding: 14 } }}>
          <Form form={fileForm} layout="vertical" onFinish={handleUpload}>
            <Dragger
              multiple
              fileList={fileList}
              beforeUpload={() => false}
              onChange={({ fileList: nextFileList }) => setFileList(nextFileList)}
              itemRender={(originNode) => originNode}
            >
              <p className="upload-icon">
                <InboxOutlined />
              </p>
              <p className="upload-title">文件</p>
              <p className="upload-hint">选择或拖入素材</p>
            </Dragger>
            <Form.Item name="title" style={{marginTop:10}}>
              <Input placeholder="标题" allowClear />
            </Form.Item>
            <Form.Item name="note">
              <Input.TextArea placeholder="备注" autoSize={{ minRows: 2, maxRows: 4 }} />
            </Form.Item>
            <Button
              block
              type="primary"
              htmlType="submit"
              icon={<UploadOutlined />}
              loading={uploading}
            >
              上传文件
            </Button>
          </Form>
        </Card>

        <Card className="hub-panel" styles={{ body: { padding: 14 } }}>
          <Form form={textForm} layout="vertical" onFinish={handleSendText}>
            <div className="panel-title-row">
              <strong>文本</strong>
              <Button size="small" icon={<CopyOutlined />} onClick={handlePasteText}>
                粘贴
              </Button>
            </div>
            <Form.Item name="title">
              <Input placeholder="标题" allowClear />
            </Form.Item>
            <Form.Item name="text">
              <Input.TextArea placeholder="接口返回、日志、token、说明" autoSize={{ minRows: 5, maxRows: 9 }} />
            </Form.Item>
            <Button
              block
              type="primary"
              htmlType="submit"
              icon={<SendOutlined />}
              loading={sendingText}
            >
              发送文本
            </Button>
          </Form>
        </Card>

        <Card className="hub-panel access-panel" styles={{ body: { padding: 14 } }}>
          <div className="panel-title-row">
            <strong>入口</strong>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => loadInfo().catch(showError)}>
              刷新
            </Button>
          </div>
          <div className="qr-wrap">
            {selectedUrl ? <QRCode value={selectedUrl} size={152} bordered={false} /> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无可用局域网地址" />}
          </div>
          <div className="url-list">
            {accessUrls.map((url) => (
              <Button
                key={url}
                className="url-pill"
                icon={<LinkOutlined />}
                onClick={() => copyText(url, '地址已复制')}
              >
                <span>{url}</span>
              </Button>
            ))}
          </div>
        </Card>
      </section>

      <section className="toolbar">
        <Segmented options={TYPE_OPTIONS} value={type} onChange={setType} />
        <Input.Search
          allowClear
          placeholder="搜索标题、文本、文件名"
          value={query}
          onChange={(event) => setQuery(event.target.value.trim().toLowerCase())}
        />
      </section>

      <section className="feed-head">
        <Title level={2}>最近素材</Title>
        <Tag>{visibleItems.length} 项</Tag>
      </section>

      <Image.PreviewGroup
        items={previewItems}
        preview={{
          visible: previewOpen,
          current: previewIndex,
          onVisibleChange: (visible) => setPreviewOpen(visible),
          onChange: (current) => setPreviewIndex(current),
        }}
      >
        <section className="items-grid" aria-live="polite">
          {visibleItems.length === 0 ? (
            <Empty
              className="empty-state"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={items.length === 0 ? '暂无素材' : '没有匹配结果'}
            />
          ) : (
            visibleItems.map((item) => (
              <MaterialCard
                key={item.id}
                item={item}
                onCopyImage={copyImage}
                onCopyText={copyText}
                onDelete={handleDelete}
                onPreview={openImagePreview}
              />
            ))
          )}
        </section>
      </Image.PreviewGroup>

      <ConnectionModal
        currentClientId={currentClientId}
        info={info}
        open={connectionOpen}
        onClose={() => setConnectionOpen(false)}
      />
    </main>
  );
}

function ConnectionModal({ currentClientId, info, open, onClose }) {
  const server = info?.serverDevice || {};
  const site = info?.site || {};
  const devices = info?.linkedDevices || [];

  return (
    <Modal
      className="connection-modal"
      footer={null}
      open={open}
      title="连接信息"
      width={760}
      onCancel={onClose}
    >
      <section className="connection-section">
        <div className="connection-section-title">
          <SettingOutlined />
          <strong>站点信息</strong>
        </div>
        <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
          <Descriptions.Item label="昵称">{displayValue(site.nickname)}</Descriptions.Item>
          <Descriptions.Item label="版本">{displayValue(site.version)}</Descriptions.Item>
          <Descriptions.Item label="服务端口">{displayValue(server.port || info?.port)}</Descriptions.Item>
          <Descriptions.Item label="启动时间">{formatTime(server.startedAt)}</Descriptions.Item>
        </Descriptions>
      </section>

      <section className="connection-section">
        <div className="connection-section-title">
          <DesktopOutlined />
          <strong>服务器设备</strong>
        </div>
        <Descriptions bordered column={{ xs: 1, sm: 2 }} size="small">
          <Descriptions.Item label="设备名">{displayValue(server.hostname)}</Descriptions.Item>
          <Descriptions.Item label="系统">{displayValue([server.platform, server.release, server.arch].filter(Boolean).join(' '))}</Descriptions.Item>
          <Descriptions.Item label="Node">{displayValue(server.node)}</Descriptions.Item>
          <Descriptions.Item label="进程">{displayValue(server.pid)}</Descriptions.Item>
          <Descriptions.Item label="监听地址">{displayValue(server.host)}</Descriptions.Item>
          <Descriptions.Item label="数据目录">{displayValue(server.dataDir)}</Descriptions.Item>
        </Descriptions>
      </section>

      <section className="connection-section">
        <div className="connection-section-title">
          <LinkOutlined />
          <strong>链接设备</strong>
          <Tag>{devices.length} 台在线</Tag>
        </div>
        <List
          bordered
          dataSource={devices}
          locale={{ emptyText: '暂无在线设备' }}
          renderItem={(device) => (
            <List.Item>
              <List.Item.Meta
                title={(
                  <Space size={6} wrap>
                    <span>{displayValue(device.deviceName || device.browser || device.ip)}</span>
                    {device.id === currentClientId ? <Tag color="green">当前设备</Tag> : null}
                  </Space>
                )}
                description={(
                  <div className="device-detail">
                    <span>IP：{displayValue(device.ip)}</span>
                    <span>系统：{displayValue(device.os)}</span>
                    <span>浏览器：{displayValue(device.browser)}</span>
                    <span>屏幕：{displayValue(device.screen)}</span>
                    <span>语言：{displayValue(device.language)}</span>
                    <span>时区：{displayValue(device.timezone)}</span>
                    <span>连接：{formatTime(device.connectedAt)}</span>
                    <span>页面：{displayValue(device.pageUrl)}</span>
                  </div>
                )}
              />
            </List.Item>
          )}
        />
      </section>
    </Modal>
  );
}

function MaterialCard({ item, onCopyImage, onCopyText, onDelete, onPreview }) {
  const isText = item.type === 'text';
  const isImage = isImageItem(item);
  const isVideo = (item.mime || '').startsWith('video/');
  const isAudio = (item.mime || '').startsWith('audio/');
  const canCopy = isText || isImage;

  const subtitle = [
    isText ? '文本' : item.fileName,
    formatBytes(item.size),
    formatTime(item.createdAt),
  ].filter(Boolean).join(' · ');

  const icon = (() => {
    if (isText) return <FileTextOutlined />;
    if (isImage) return <PictureOutlined />;
    if (isVideo) return <VideoCameraOutlined />;
    if (isAudio) return <AudioOutlined />;
    return <FileOutlined />;
  })();

  return (
    <Card
      className="item-card"
      styles={{ body: { padding: 0 } }}
      cover={<ItemPreview item={item} onPreview={onPreview} />}
    >
      <div className="item-body">
        <div className="item-meta">
          <Space size={6} className="item-title-row">
            {icon}
            <Tooltip title={item.title || item.fileName || '未命名素材'}>
              <strong className="item-title">{item.title || item.fileName || '未命名素材'}</strong>
            </Tooltip>
          </Space>
          <Text className="item-subtitle">{subtitle}</Text>
        </div>
        {item.note ? <Text className="item-note">{item.note}</Text> : null}
        <div className={`item-actions ${canCopy ? '' : 'without-copy'}`}>
          {canCopy ? (
            <Button
              icon={<CopyOutlined />}
              onClick={() => {
                if (isText) onCopyText(item.text || '', '文本已复制');
                else onCopyImage(item);
              }}
            >
              复制
            </Button>
          ) : null}
          <Button icon={<DownloadOutlined />} href={item.downloadUrl} download={item.fileName || `${item.title || 'text'}.txt`}>
            下载
          </Button>
          <Button danger icon={<DeleteOutlined />} onClick={() => onDelete(item)}>
            删除
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ItemPreview({ item, onPreview }) {
  if (item.type === 'text') {
    return <pre className="text-preview">{item.text || ''}</pre>;
  }

  if (isImageItem(item)) {
    return (
      <button className="image-preview-button" type="button" onClick={() => onPreview(item)}>
        <img loading="lazy" alt={item.fileName || item.title || 'image'} src={item.rawUrl} />
      </button>
    );
  }

  if ((item.mime || '').startsWith('video/')) {
    return <video className="media-preview" controls preload="metadata" src={item.rawUrl} />;
  }

  if ((item.mime || '').startsWith('audio/')) {
    return (
      <div className="file-preview">
        <audio controls src={item.rawUrl} />
      </div>
    );
  }

  return (
    <div className="file-preview">
      <div className="file-badge">{extensionOf(item.fileName)}</div>
    </div>
  );
}
