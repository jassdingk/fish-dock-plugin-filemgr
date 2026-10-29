# Windows 原生文件夹/文件选择对话框的 C# 实现（IFileOpenDialog）。
# 由 pick-folder.ps1 / pick-files.ps1 通过 Add-Type -TypeDefinition 编译，避免依赖 .cs 文件。
$FolderPickerSource = @'
// Windows 原生"选择文件夹"对话框（IFileOpenDialog + FOS_PICKFOLDERS）。
// 与 FISH Dock 宿主 paper.rs:588 用的是同一个 COM 接口，所以外观和系统资源管理器
// 的"选择文件夹"完全一致，而不是 WinForms 那棵 1995 年的老树。
using System;
using System.Runtime.InteropServices;

namespace FishDockPick
{
    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint c, IntPtr rg);
        void SetFileTypeIndex(uint i);
        void GetFileTypeIndex(out uint i);
        void Advise(IntPtr e, out uint c);
        void Unadvise(uint c);
        void SetOptions(uint o);
        void GetOptions(out uint o);
        void SetDefaultFolder(IShellItem si);
        void SetFolder(IShellItem si);
        void GetFolder(out IShellItem si);
        void GetCurrentSelection(out IShellItem si);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem si);
        void AddPlace(IShellItem si, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string ext);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string name);
        void GetAttributes(uint sfgaoMask, out uint sfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int order);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    internal class FileOpenDialog { }

    // IFileOpenDialog — 多选文件需要这个接口（继承 IFileDialog，多了 GetResults）。
    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint c, IntPtr rg);
        void SetFileTypeIndex(uint i);
        void GetFileTypeIndex(out uint i);
        void Advise(IntPtr e, out uint c);
        void Unadvise(uint c);
        void SetOptions(uint o);
        void GetOptions(out uint o);
        void SetDefaultFolder(IShellItem si);
        void SetFolder(IShellItem si);
        void GetFolder(out IShellItem si);
        void GetCurrentSelection(out IShellItem si);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem si);
        void AddPlace(IShellItem si, int fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string ext);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
        void GetResults(out IShellItemArray ppenum);
        void GetSelectedItems(out IShellItemArray ppsai);
    }

    [ComImport, Guid("b63ea76d-1f85-456f-a19c-48159efa858b"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItemArray
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
        void GetPropertyDescriptionList(IntPtr keyType, ref Guid riid, out IntPtr ppv);
        void GetAttributes(uint AttribFlags, uint sfgaoMask, out uint psfgaoAttribs);
        void GetCount(out uint pdwNumItems);
        void GetItemAt(uint dwIndex, out IShellItem ppsi);
        void EnumItems(out IntPtr ppenumShellItems);
    }

    public static class FolderPicker
    {
        private const uint FOS_PICKFOLDERS = 0x20;
        private const uint FOS_FORCEFILESYSTEM = 0x40;
        private const uint FOS_PATHMUSTEXIST = 0x800;
        private const uint FOS_ALLOWMULTISELECT = 0x200;
        private const uint SIGDN_FILESYSPATH = 0x80058000;
        private const int ERROR_CANCELLED = unchecked((int)0x800704C7);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        private static extern void SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
            IntPtr pbc,
            ref Guid riid,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

        [DllImport("ole32.dll")]
        private static extern int CoInitializeEx(IntPtr pvReserved, uint dwCoInit);

        [DllImport("ole32.dll")]
        private static extern void CoUninitialize();

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool AllowSetForegroundWindow(int dwProcessId);

        // 只初始化 COM 和创建对话框对象，不弹窗——供自检用。
        public static string Selftest()
        {
            int hr = CoInitializeEx(IntPtr.Zero, 2 /* APARTMENTTHREADED */);
            try
            {
                IFileDialog dlg = (IFileDialog)new FileOpenDialog();
                uint opts;
                dlg.GetOptions(out opts);
                dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);
                dlg.SetTitle("选择文件夹");
                return "COM_OK hr=0x" + hr.ToString("X8");
            }
            finally
            {
                if (hr >= 0) CoUninitialize();
            }
        }

        public static string Pick(string initial, string title)
        {
            int hr = CoInitializeEx(IntPtr.Zero, 2 /* APARTMENTTHREADED */);
            try
            {
                IFileDialog dlg = (IFileDialog)new FileOpenDialog();
                uint opts;
                dlg.GetOptions(out opts);
                dlg.SetOptions(opts | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);

                if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);

                if (!string.IsNullOrEmpty(initial))
                {
                    try
                    {
                        Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                        IShellItem folder;
                        SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
                        if (folder != null) dlg.SetFolder(folder);
                    }
                    catch { /* 起始目录不存在就退回系统默认 */ }
                }

                // 关键：本进程是被宿主当子进程拉起来的、且宿主页面还是隐藏窗口，
                // 系统默认会把对话框排在后面，用户看到的是"点了没反应"。
                // 先让操作系统允许本进程抢前台，再 Show 时把父窗口设为 NULL，
                // 弹出来之后主动 SetForegroundWindow，保证一定浮在最上面。
                AllowSetForegroundWindow(-1 /* ASFW_ANY */);

                int show = dlg.Show(IntPtr.Zero);
                if (show == ERROR_CANCELLED || show != 0) return null;

                IShellItem item;
                dlg.GetResult(out item);
                if (item == null) return null;

                string path;
                item.GetDisplayName(SIGDN_FILESYSPATH, out path);
                return path;
            }
            finally
            {
                if (hr >= 0) CoUninitialize();
            }
        }

        /// <summary>
        /// 弹出多选文件对话框（无 FOS_PICKFOLDERS，加 FOS_ALLOWMULTISELECT）。
        /// 返回选中的路径数组，取消返回空数组。
        /// </summary>
        public static string[] PickFiles(string initial, string title)
        {
            int hr = CoInitializeEx(IntPtr.Zero, 2 /* APARTMENTTHREADED */);
            try
            {
                var dlg = (IFileOpenDialog)new FileOpenDialog();
                uint opts;
                dlg.GetOptions(out opts);
                dlg.SetOptions(opts | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST | FOS_ALLOWMULTISELECT);

                if (!string.IsNullOrEmpty(title)) dlg.SetTitle(title);

                if (!string.IsNullOrEmpty(initial))
                {
                    try
                    {
                        Guid iid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                        IShellItem folder;
                        SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out folder);
                        if (folder != null) ((IFileDialog)dlg).SetFolder(folder);
                    }
                    catch { /* 起始目录不存在就退回系统默认 */ }
                }

                AllowSetForegroundWindow(-1 /* ASFW_ANY */);

                int show = ((IFileDialog)dlg).Show(IntPtr.Zero);
                if (show == ERROR_CANCELLED || show != 0) return new string[0];

                IShellItemArray results;
                dlg.GetResults(out results);
                if (results == null) return new string[0];

                uint count;
                results.GetCount(out count);
                var paths = new string[count];
                for (uint i = 0; i < count; i++)
                {
                    IShellItem item;
                    results.GetItemAt(i, out item);
                    if (item != null)
                    {
                        string path;
                        item.GetDisplayName(SIGDN_FILESYSPATH, out path);
                        paths[i] = path;
                    }
                }
                return paths;
            }
            finally
            {
                if (hr >= 0) CoUninitialize();
            }
        }
    }
}

'@
